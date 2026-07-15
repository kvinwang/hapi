import { describe, expect, test } from 'bun:test'
import { toolResultText } from './sharePage'

describe('toolResultText', () => {
    test('returns plain strings', () => {
        expect(toolResultText('hello')).toBe('hello')
    })

    test('joins content-block arrays', () => {
        expect(toolResultText([
            { type: 'text', text: 'Line 1' },
            { type: 'text', text: 'Line 2' },
        ])).toBe('Line 1\nLine 2')
    })

    test('decodes Grok UTF-8 byte arrays', () => {
        const text = 'remove me\nok'
        const bytes = Array.from(Buffer.from(text, 'utf8'))
        expect(toolResultText(bytes)).toBe(text)
        expect(toolResultText({ type: 'Bash', output: bytes })).toBe(text)
    })

    test('decodes multi-byte UTF-8 byte arrays', () => {
        const text = '你好 world'
        const bytes = Array.from(Buffer.from(text, 'utf8'))
        expect(toolResultText({ output: bytes })).toBe(text)
    })

    test('prefers stdout/stderr strings', () => {
        expect(toolResultText({
            stdout: 'out line',
            stderr: 'err line',
            exit_code: 0,
        })).toBe('out line\nerr line')
    })

    test('unwraps JSON-encoded content-block arrays', () => {
        const encoded = JSON.stringify([{ type: 'text', text: 'hello from shell' }])
        expect(toolResultText(encoded)).toBe('hello from shell')
        expect(toolResultText({ stdout: encoded })).toBe('hello from shell')
    })

    test('reads Codex-style { output: string } results', () => {
        expect(toolResultText({
            command: 'ls',
            cwd: '/tmp',
            output: 'a\nb\n',
            exit_code: 0,
            status: 'completed',
        })).toBe('a\nb\n')
    })

    test('strips ANSI sequences', () => {
        expect(toolResultText('\u001b[31mError:\u001b[0m failed')).toBe('Error: failed')
    })
})
