import { describe, expect, it } from 'bun:test'
import { extractAssistantText } from './assistantText'

describe('assistant text extraction', () => {
    it('extracts Codex replies without confusing reasoning and tool output with replies', () => {
        const content = (data: object) => ({ role: 'agent', content: { type: 'codex', data } })
        expect(extractAssistantText(content({ type: 'message', message: 'The concrete reply' }))).toBe('The concrete reply')
        expect(extractAssistantText(content({ type: 'reasoning', message: 'Internal reasoning' }))).toBeNull()
        expect(extractAssistantText(content({ type: 'tool-call-result', output: 'Tool output' }))).toBeNull()
    })
})
