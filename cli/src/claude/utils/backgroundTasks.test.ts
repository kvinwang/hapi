import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Metadata } from '@/api/types'
import { ClaudeBackgroundTasks } from './backgroundTasks'

function setup() {
    let metadata: Metadata = { path: '/repo', host: 'box' }
    const tracker = new ClaudeBackgroundTasks({
        getMetadata: () => metadata,
        updateMetadata: update => { metadata = update(metadata) }
    })
    const start = () => {
        tracker.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'sleep 60', description: 'Wait' } }] } })
        tracker.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash1', content: 'Command running in background with ID: bg1. Output is being written to: /tmp/bg1.output. You will be notified when it completes.' }] } })
    }
    return { tracker, start, tasks: () => metadata.backgroundTasks }
}

describe('ClaudeBackgroundTasks', () => {
    it('keeps background shells running after the tool result and turn completion', () => {
        const { tracker, start, tasks } = setup()
        start()
        tracker.observe({ type: 'result' })
        expect(tasks()?.bg1).toMatchObject({ status: 'running', command: 'sleep 60', outputFile: '/tmp/bg1.output' })
        tracker.observe({ type: 'user', message: { content: '<task-notification><task-id>bg1</task-id><status>completed</status><summary>Done</summary></task-notification>' } })
        expect(tasks()?.bg1).toMatchObject({ status: 'completed', summary: 'Done', finishedAt: expect.any(Number) })
    })

    it('tracks shell lifecycle events without including agents', () => {
        const { tracker, start, tasks } = setup()
        start()
        tracker.observe({ type: 'system', subtype: 'task_started', task_id: 'agent1', tool_use_id: 'agent-tool', task_type: 'local_agent' })
        tracker.observe({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'failed', summary: 'Exit 1' })
        expect(Object.keys(tasks()!)).toEqual(['bg1'])
        expect(tasks()?.bg1.status).toBe('failed')
    })

    it('marks tasks unknown after process loss instead of claiming they stopped', () => {
        const { tracker, start, tasks } = setup()
        start()
        tracker.markUnknown()
        expect(tasks()?.bg1.status).toBe('unknown')
    })

    it('returns only the last 64 KiB of a tracked output file', async () => {
        const { tracker, start } = setup()
        const directory = await mkdtemp(join(tmpdir(), 'hapi-task-output-'))
        try {
            const path = join(directory, 'output')
            await writeFile(path, 'x'.repeat(70000) + 'done')
            start()
            tracker.observe({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', output_file: path })
            const { output } = await tracker.output('bg1')
            expect(Buffer.byteLength(output)).toBe(64 * 1024)
            expect(output.endsWith('done')).toBe(true)
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    it('does not turn synchronous shell results into tasks', async () => {
        const { tracker, tasks } = setup()
        tracker.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'echo hi' } }] } })
        tracker.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash1', content: 'hi' }] } })
        expect(tasks()).toBeUndefined()
        await expect(tracker.output('missing')).rejects.toThrow('Unknown background task')
    })
})
