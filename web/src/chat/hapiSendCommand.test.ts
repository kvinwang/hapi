import { describe, expect, it } from 'vitest'
import { getHapiSendCommand, parseHapiSendCommand } from './hapiSendCommand'

describe('parseHapiSendCommand', () => {
    it('extracts unquoted and quoted session IDs', () => {
        expect(parseHapiSendCommand('hapi send session-123 "hello world"')).toEqual({
            target: 'session-123', message: 'hello world'
        })
        expect(parseHapiSendCommand("hapi send 'session 123' hello")).toEqual({
            target: 'session 123', message: 'hello'
        })
    })

    it('finds hapi send after another shell command', () => {
        expect(parseHapiSendCommand('cd /repo && hapi send abc message')).toEqual({
            target: 'abc', message: 'message'
        })
    })

    it('does not classify incidental command text', () => {
        expect(parseHapiSendCommand('echo "hapi send abc message"')).toBeNull()
        expect(parseHapiSendCommand('rg "hapi send" README.md')).toBeNull()
    })

    it('does not classify usage-only invocations as sent messages', () => {
        expect(parseHapiSendCommand('hapi send 2>&1 || true')).toBeNull()
        expect(parseHapiSendCommand('hapi send session-123')).toBeNull()
        expect(parseHapiSendCommand("ssh host 'check; /home/kvin/.local/bin/hapi send 2>&1 || true'")).toBeNull()
    })
})

describe('getHapiSendCommand', () => {
    it('only classifies shell tool calls', () => {
        expect(getHapiSendCommand('Bash', { command: 'hapi send target hello' })).toEqual({
            target: 'target', message: 'hello'
        })
        expect(getHapiSendCommand('Read', { command: 'hapi send target hello' })).toBeNull()
    })
})
