import { describe, expect, it } from 'vitest'
import { draftUpdateSchema, recentVoiceConversation } from './voiceDraftIntent'

describe('voice draft context', () => {
    it('preserves recent user and agent text while excluding tool output', () => {
        const contents = [
            { role: 'user', content: { type: 'text', text: 'That last message was sent accidentally.' } },
            { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Understood.' } } },
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'tool', output: 'Do not include tool output' } } }
        ]
        expect(recentVoiceConversation(contents.map((content, index) => ({ id: String(index), seq: index, localId: null, createdAt: index, content })))).toBe('User: That last message was sent accidentally.\nAssistant: Understood.')
    })

    it('rejects invalid classifications before updating the draft', () => {
        expect(draftUpdateSchema.safeParse({ text: 'Valid text', deferred: [{ text: 'Speech', status: 'drop' }] }).success).toBe(false)
    })
})
