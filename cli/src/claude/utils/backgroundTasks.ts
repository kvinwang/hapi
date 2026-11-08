import { open } from 'node:fs/promises'
import type { BackgroundTask } from '@hapi/protocol/types'
import type { ApiSessionClient } from '@/api/apiSession'
import type { SDKMessage } from '@/claude/sdk'

type Fields = Record<string, unknown>
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const fields = (value: unknown): Fields => value !== null && typeof value === 'object' ? value as Fields : {}
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(block => str(fields(block).text) ?? '').join('\n') : ''

export class ClaudeBackgroundTasks {
    private readonly calls = new Map<string, { command: string; description: string; parentToolUseId?: string }>()

    constructor(private readonly client: Pick<ApiSessionClient, 'getMetadata' | 'updateMetadata'>) {}

    private patch(id: string, patch: Partial<BackgroundTask>): void {
        this.client.updateMetadata(metadata => {
            const previous = metadata.backgroundTasks?.[id]
            const task: BackgroundTask = { id, description: id, startedAt: Date.now(), status: 'running', ...previous, ...patch }
            const tasks = { ...metadata.backgroundTasks, [id]: task }
            const finished = Object.values(tasks).filter(entry => entry.status !== 'running').sort((a, b) => b.startedAt - a.startedAt)
            for (const entry of finished.slice(100)) delete tasks[entry.id]
            return { ...metadata, backgroundTasks: tasks }
        })
    }

    markUnknown(): void {
        for (const task of Object.values(this.client.getMetadata()?.backgroundTasks ?? {})) {
            if (task.status === 'running') this.patch(task.id, { status: 'unknown' })
        }
    }

    observe(message: SDKMessage): void {
        const content = fields(message.message).content
        if (message.type === 'assistant' && Array.isArray(content)) {
            for (const block of content.map(fields)) {
                if (block.type !== 'tool_use' || block.name !== 'Bash' || typeof block.id !== 'string') continue
                const input = fields(block.input)
                this.calls.set(block.id, {
                    command: str(input.command) ?? '', description: str(input.description) ?? str(input.command) ?? 'Shell task',
                    parentToolUseId: message.parent_tool_use_id ?? undefined
                })
            }
        }
        if (message.type === 'system') {
            const toolUseId = str(message.tool_use_id)
            const id = str(message.task_id) ?? Object.values(this.client.getMetadata()?.backgroundTasks ?? {}).find(task => toolUseId && task.toolUseId === toolUseId)?.id
            if (!id) return
            const call = toolUseId ? this.calls.get(toolUseId) : undefined
            // Agent tasks have their own list. Only track shell tasks or already-known task IDs.
            if (!call && !this.client.getMetadata()?.backgroundTasks?.[id]) return
            if (message.subtype === 'task_started') {
                this.patch(id, { ...call, toolUseId, outputFile: str(message.output_file), description: str(message.description) ?? call?.description ?? id })
            } else if (message.subtype === 'task_notification') {
                this.finish(id, message.status, str(message.summary), str(message.output_file))
            }
        }
        if (message.type !== 'user') return
        if (Array.isArray(content)) {
            for (const block of content.map(fields)) {
                const toolUseId = str(block.tool_use_id)
                const call = toolUseId ? this.calls.get(toolUseId) : undefined
                if (block.type !== 'tool_result' || !call) continue
                this.calls.delete(toolUseId!)
                const result = text(block.content)
                const details = fields(message.tool_use_result)
                const id = str(details.backgroundTaskId) ?? result.match(/Command running in background with ID: ([\w-]+)/)?.[1]
                    ?? result.match(/Background task ID: ([\w-]+)/i)?.[1]
                if (!id) continue
                const previous = this.client.getMetadata()?.backgroundTasks?.[id]
                const outputFile = str(details.outputFile) ?? result.match(/Output is being written to: (.+?)(?:\. You|\n|$)/)?.[1]
                this.patch(id, { ...call, toolUseId, ...(outputFile ? { outputFile } : {}), ...(previous ? { status: previous.status } : {}) })
            }
        }
        const notification = text(content)
        if (!notification.trimStart().startsWith('<task-notification>')) return
        const tag = (name: string) => notification.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()
        const id = tag('task-id')
        if (id && this.client.getMetadata()?.backgroundTasks?.[id]) this.finish(id, tag('status'), tag('summary'), tag('output-file'))
    }

    private finish(id: string, status: unknown, summary?: string, outputFile?: string): void {
        this.patch(id, {
            status: status === 'completed' || status === 'failed' ? status : status === 'stopped' ? 'stopped' : 'unknown',
            finishedAt: Date.now(), summary,
            ...(outputFile ? { outputFile } : {})
        })
    }

    get(id: string): BackgroundTask {
        const task = this.client.getMetadata()?.backgroundTasks?.[id]
        if (!task) throw new Error('Unknown background task')
        return task
    }

    async output(id: string): Promise<{ output: string }> {
        const task = this.get(id)
        if (!task.outputFile) return { output: task.summary ?? '' }
        const file = await open(task.outputFile, 'r')
        try {
            const { size } = await file.stat()
            const buffer = Buffer.alloc(Math.min(size, 64 * 1024))
            const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length))
            return { output: buffer.subarray(0, bytesRead).toString('utf8') }
        } finally {
            await file.close()
        }
    }
}
