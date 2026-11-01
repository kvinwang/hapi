import { describe, expect, it } from 'vitest'
import { spokenTerminalKey, TERMINAL_KEYS } from './terminalKeys'

describe('spoken terminal keys', () => {
    it.each(['Ctrl+C', 'control c', '按 Ctrl+C。', '中断命令'])('recognizes an explicit interrupt: %s', (text) => {
        expect(spokenTerminalKey(text)).toBe('interrupt')
        expect(TERMINAL_KEYS.interrupt.sequence).toBe('\x03')
    })
    it.each([['回车', 'enter'], ['Tab', 'tab'], ['Esc', 'escape'], ['上一条命令', 'up'], ['退格', 'backspace'], ['Ctrl+D', 'endInput']])('recognizes %s', (text, key) => {
        expect(spokenTerminalKey(text)).toBe(key)
    })
    it.each(['不要按Ctrl+C', '这里的Ctrl+C有问题', '“Ctrl+C”', '增加一个回车按钮'])('does not treat descriptions as key presses: %s', (text) => {
        expect(spokenTerminalKey(text)).toBeNull()
    })
})
