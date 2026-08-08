import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import { projectMessagesPage, projectPageMessage, projectToolDescriptor } from './pageProjection'
import type { ChatSourceMessage } from './types'

let nextSeq = 0
function message(content: unknown): ChatSourceMessage {
    nextSeq += 1
    return { id: `m${nextSeq}`, seq: nextSeq, localId: null, createdAt: 1_000 + nextSeq, content }
}

function claudeAssistant(blocks: unknown[], usage?: unknown): ChatSourceMessage {
    return message({
        role: 'agent',
        content: {
            type: 'output',
            data: {
                parentUuid: 'p',
                isSidechain: false,
                userType: 'external',
                cwd: '/repo',
                sessionId: 's',
                version: '1.2.3',
                gitBranch: 'main',
                uuid: 'u',
                timestamp: '2026-01-01T00:00:00Z',
                type: 'assistant',
                message: {
                    model: 'claude-test',
                    id: 'api-1',
                    type: 'message',
                    role: 'assistant',
                    content: blocks,
                    stop_reason: null,
                    stop_details: null,
                    diagnostics: { cache_miss_reason: { type: 'unavailable' } },
                    ...(usage ? { usage } : {})
                }
            }
        },
        meta: {
            sentFrom: 'cli',
            agentFlavor: 'claude',
            agentModel: 'claude-test',
            appendSystemPrompt: 'x'.repeat(4_000)
        }
    })
}

describe('page projection', () => {
    it('keeps what the client reads and drops the rest', () => {
        nextSeq = 0
        const source = claudeAssistant([{ type: 'text', text: 'Hello' }])
        const projected = projectPageMessage(source, { sessionCwd: '/repo' })!
        const serialized = JSON.stringify(projected)

        expect(serialized).toContain('Hello')
        expect(serialized).toContain('sentFrom')
        expect(serialized).toContain('agentFlavor')
        expect(serialized).toContain('agentModel')
        for (const gone of ['appendSystemPrompt', 'gitBranch', 'sessionId', 'timestamp', 'stop_reason', 'diagnostics', 'userType']) {
            expect(serialized).not.toContain(gone)
        }
        // Same cwd as the session: nothing to say.
        expect(serialized).not.toContain('/repo')
        // What is drawn survives. The uuid a part carries is only read to stitch
        // subagent transcripts together, which this message is not part of.
        const drawn = (entry: ChatSourceMessage) => {
            const normalized = normalizeDecryptedMessage(entry)!
            return {
                role: normalized.role,
                usage: normalized.usage,
                model: normalized.model,
                content: normalized.content.map((part) => ({ ...part, uuid: undefined, parentUUID: undefined }))
            }
        }
        expect(drawn(projected)).toEqual(drawn(source))
    })

    it('carries a cwd that differs from the session', () => {
        nextSeq = 0
        const projected = projectPageMessage(claudeAssistant([{ type: 'text', text: 'Hi' }]), { sessionCwd: '/elsewhere' })!
        expect(JSON.stringify(projected)).toContain('/repo')
    })

    it('drops the signature of a thinking block, and the block when it is empty', () => {
        nextSeq = 0
        const withText = projectPageMessage(claudeAssistant([{ type: 'thinking', thinking: 'why', signature: 'sig' }]))!
        expect(JSON.stringify(withText)).toContain('why')
        expect(JSON.stringify(withText)).not.toContain('sig')

        nextSeq = 0
        const empty = projectPageMessage(claudeAssistant([{ type: 'thinking', thinking: '', signature: 'sig' }]))
        expect(empty).toBeNull()
    })

    it('drops a message kind the client cannot render', () => {
        nextSeq = 0
        const progress = message({
            role: 'agent',
            content: { type: 'output', data: { type: 'tool_progress', message: { content: [] } } }
        })
        expect(projectPageMessage(progress)).toBeNull()
        expect(normalizeDecryptedMessage(progress)).toBeNull()
    })

    it('folds a run of usage-only messages into its first and last', () => {
        nextSeq = 0
        const usage = (input: number) => claudeAssistant([], {
            input_tokens: input,
            output_tokens: 1,
            cache_read_input_tokens: 2
        })
        const page = [usage(10), usage(20), usage(30), usage(40)]

        const projected = projectMessagesPage(page)

        expect(projected).toHaveLength(2)
        const sumOf = (list: ChatSourceMessage[]) => list.reduce((total, entry) => {
            const value = normalizeDecryptedMessage(entry)?.usage
            return total + (value?.input_tokens ?? 0)
        }, 0)
        // 10 + 20 + 30 ride on the first; the newest one stays untouched for the
        // context readout.
        expect(sumOf(projected)).toBe(sumOf(page))
        expect(normalizeDecryptedMessage(projected[1])?.usage?.input_tokens).toBe(40)
    })

    it('reduces a tool descriptor to what the collapsed row draws', () => {
        const projected = projectToolDescriptor({
            id: 't1',
            name: 'Edit',
            state: 'completed',
            input: {
                file_path: '/repo/src/a.ts',
                old_string: 'x'.repeat(5_000),
                new_string: 'y'.repeat(5_000),
                replace_all: false,
                edits: [{}, {}, {}]
            },
            description: null,
            createdAt: 5,
            startedAt: 5,
            completedAt: 9,
            resultPending: true
        })

        expect(projected).toEqual({
            id: 't1',
            name: 'Edit',
            state: 'completed',
            input: { file_path: '/repo/src/a.ts', edits: [null, null, null] },
            resultPending: true
        })
    })

    it('cuts a command to a row of text and does not repeat the description', () => {
        const projected = projectToolDescriptor({
            id: 't3',
            name: 'Bash',
            state: 'completed',
            input: { command: `echo ${'x'.repeat(400)}`, description: 'Say something', timeout: 360_000 },
            description: 'Say something',
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            resultPending: true
        })

        const input = projected.input as Record<string, unknown>
        expect(new TextEncoder().encode(String(input.command)).length).toBeLessThanOrEqual(64 + 3)
        expect(input.description).toBeUndefined()
        expect(input.timeout).toBeUndefined()
        expect(projected.description).toBe('Say something')
    })

    it('keeps the clock inputs of a running tool', () => {
        const projected = projectToolDescriptor({
            id: 't2',
            name: 'Bash',
            state: 'running',
            input: { command: 'ls' },
            description: 'List files',
            createdAt: 7,
            startedAt: 7,
            completedAt: null,
            resultPending: true
        })
        expect(projected.startedAt).toBe(7)
        expect(projected.description).toBe('List files')
    })
})
