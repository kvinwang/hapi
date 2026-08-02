import { describe, expect, it } from 'vitest'
import type { SessionHistoryMessage } from '@/api/types'
import { countContextTurns, formatSessionContext, parseSessionContextArgs } from './sessionContext'

function message(seq: number, content: unknown): SessionHistoryMessage {
    return {
        id: `m-${seq}`,
        seq,
        createdAt: seq,
        localId: null,
        content,
        role: null,
        text: null
    }
}

const history: SessionHistoryMessage[] = [
    message(1, {
        role: 'user',
        content: { type: 'text', text: 'Inspect the failure' },
        meta: { appendSystemPrompt: 'very large repeated prompt' }
    }),
    message(2, {
        role: 'agent',
        content: { type: 'codex', data: { type: 'token_count', info: { total: { totalTokens: 99 } } } }
    }),
    message(3, {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'tool-call',
                name: 'CodexBash',
                callId: 'call-1',
                input: { command: 'git status --short', cwd: '/repo' }
            }
        }
    }),
    message(4, {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'tool-call-result',
                callId: 'call-1',
                output: { output: ' M src/file.ts', exit_code: 0, status: 'completed' }
            }
        }
    }),
    message(5, {
        role: 'agent',
        content: { type: 'codex', data: { type: 'message', message: 'The working tree is dirty.' } }
    }),
    message(6, {
        role: 'agent',
        content: { id: 'ready-1', type: 'event', data: { type: 'ready' } }
    })
]

describe('parseSessionContextArgs', () => {
    it('defaults the session ID from HAPI_SESSION_ID', () => {
        expect(parseSessionContextArgs(['context'], { HAPI_SESSION_ID: 'session-1' })).toEqual({
            sessionId: 'session-1',
            turns: 20,
            maxChars: 16_000,
            tools: 'summary'
        })
    })

    it('accepts explicit context controls', () => {
        expect(parseSessionContextArgs([
            'context', '--session', 'session-2', '--turns=5', '--max-chars', '8000', '--tools', 'none'
        ], {})).toEqual({ sessionId: 'session-2', turns: 5, maxChars: 8000, tools: 'none' })
    })
})

describe('formatSessionContext', () => {
    it('keeps semantic dialogue and paired tools while dropping transport noise', () => {
        const output = formatSessionContext('session-1', history, {
            turns: 20,
            maxChars: 16_000,
            tools: 'summary'
        })

        expect(output).toContain('[1] User:\nInspect the failure')
        expect(output).toContain('[tool seq=3 result=4]:\nCodexBash: git status --short')
        expect(output).toContain('Result:')
        expect(output).toContain('[5] Assistant:\nThe working tree is dirty.')
        expect(output).not.toContain('token_count')
        expect(output).not.toContain('ready')
        expect(output).not.toContain('appendSystemPrompt')
        expect(output.match(/git status --short/g)).toHaveLength(1)
    })

    it('can omit tools entirely', () => {
        const output = formatSessionContext('session-1', history, {
            turns: 20,
            maxChars: 16_000,
            tools: 'none'
        })
        expect(output).not.toContain('CodexBash')
        expect(output).toContain('The working tree is dirty.')
    })

    it('counts normalized user turns', () => {
        expect(countContextTurns(history)).toBe(1)
    })
})
