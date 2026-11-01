import { describe, expect, it } from 'vitest'
import { terminalVoiceInput } from './terminalVoice'

describe('terminal command drafts', () => {
    it('only appends Enter when explicitly enabled', () => {
        expect(terminalVoiceInput(' ls -lah ', false)).toBe('ls -lah')
        expect(terminalVoiceInput('ls -lah', true)).toBe('ls -lah\r')
    })
    it.each(['ls\npwd', 'ls\rpwd', '\x1b[A', 'ls\x00pwd'])('rejects hidden line submissions and control keys', (command) => {
        expect(() => terminalVoiceInput(command, false)).toThrow('terminalSingleLine')
    })
})
