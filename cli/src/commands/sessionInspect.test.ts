import { describe, expect, it } from 'vitest'
import type { SessionHistoryMessage } from '@/api/types'
import { formatToolInspections, inspectToolCalls, parseSessionInspectArgs, rawInspectionMessages } from './sessionInspect'

function message(seq: number, content: unknown): SessionHistoryMessage {
    return { id: `m-${seq}`, seq, createdAt: seq, localId: null, content, role: null, text: null }
}

const messages = [
    message(28, {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'tool-call',
                name: 'CodexBash',
                callId: 'call-1',
                input: { command: 'git status', cwd: '/repo' }
            }
        }
    }),
    message(29, {
        role: 'agent',
        content: { type: 'codex', data: { type: 'token_count', info: {} } }
    }),
    message(30, {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'tool-call-result',
                callId: 'call-1',
                output: { output: 'clean', exit_code: 0, status: 'completed' }
            }
        }
    })
]

describe('parseSessionInspectArgs', () => {
    it('uses HAPI_SESSION_ID by default', () => {
        expect(parseSessionInspectArgs(['inspect', '28'], { HAPI_SESSION_ID: 'session-1' })).toEqual({
            sessionId: 'session-1',
            seq: 28,
            format: 'text',
            raw: false
        })
    })

    it('accepts explicit JSON and raw options', () => {
        expect(parseSessionInspectArgs([
            'inspect', '28', '--session=session-2', '--format', 'json', '--raw'
        ], {})).toEqual({ sessionId: 'session-2', seq: 28, format: 'json', raw: true })
    })
})

describe('inspectToolCalls', () => {
    it('pairs a call with its result across noise messages', () => {
        const inspected = inspectToolCalls(messages, 28)
        expect(inspected).toHaveLength(1)
        expect(inspected[0]).toMatchObject({
            id: 'call-1',
            name: 'CodexBash',
            callSeq: 28,
            resultSeq: 30,
            input: { command: 'git status', cwd: '/repo' },
            isError: false
        })
        expect(formatToolInspections(inspected)).toContain('Seq: 28–30')
        expect(formatToolInspections(inspected)).toContain('clean')
        expect(rawInspectionMessages(messages, inspected).map(item => item.seq)).toEqual([28, 30])
    })
})
