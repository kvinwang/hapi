import { describe, expect, it, vi } from 'vitest'
import { executeFrontendCommand, frontendCommandHelp, frontendCommandSummary } from './frontendCommands'

describe('frontend command interpreter', () => {
    it.each([
        ['draft send', { action: 'draft_send' }],
        ['draft clear', { action: 'draft_clear' }],
        ['draft choose 2', { action: 'draft_choose', index: 2 }],
        ['draft pending include 1', { action: 'draft_pending', index: 1, include: true }],
        ['draft delay 7', { action: 'auto_send', delay: 7 }],
        ['mic enabled off', { action: 'mic_enabled', enabled: false }],
        ['readback output system', { action: 'readback_output', device: 'system' }],
        ['draft language en', { action: 'draft_language', language: 'en' }],
        ['draft language original', { action: 'draft_language', language: 'original' }],
        ['draft alternatives off', { action: 'draft_alternatives', enabled: false }],
        ['draft mode manual', { action: 'draft_mode', mode: 'manual' }],
        ['draft panel show', { action: 'draft_panel', open: true }],
        ['draft auto-send on 5', { action: 'auto_send', enabled: true, delay: 5 }],
        ['draft auto-send off', { action: 'auto_send', enabled: false }],
        ['mic sensitivity 75', { action: 'mic_sensitivity', value: 75 }],
        ['mic environment noisy', { action: 'mic_environment', environment: 'noisy' }],
        ['readback volume 200', { action: 'readback_volume', value: 200 }],
        ['readback duck-threshold -30', { action: 'duck_threshold', value: -30 }],
        ['readback duck-threshold off', { action: 'duck_threshold', value: 0 }],
        ['readback duck-level 50', { action: 'duck_level', value: 50 }],
        ['terminal execute on', { action: 'terminal_execute', enabled: true }],
        ['voice glow off', { action: 'edge_glow', enabled: false }],
        ['readback language zh', { action: 'readback_language', language: 'zh' }],
        ['readback enabled off', { action: 'readback', enabled: false }],
        ['readback stop', { action: 'stop_readback' }],
        ['readback own-messages on', { action: 'readback_own', enabled: true }],
        ['readback final-only off', { action: 'readback_final_only', enabled: false }],
        ['readback replay', { action: 'replay_readback' }],
        ['readback replay "test results"', { action: 'replay_readback', focus: 'test results' }],
        ["readback ask 'What does this mean?'", { action: 'answer_readback', question: 'What does this mean?' }],
        ['session list', { action: 'list_sessions' }],
        ['session list "microphone recovery"', { action: 'list_sessions', query: 'microphone recovery' }],
        ['session switch session-1', { action: 'switch_session', sessionId: 'session-1' }],
        ['session suggest "work" session-1 session-2', { action: 'suggest_sessions', query: 'work', sessionIds: ['session-1', 'session-2'] }],
        ['session select 2', { action: 'select_session', index: 2 }],
        ['session cancel', { action: 'cancel_selection' }],
        ['voice reset', { action: 'reset_voice' }],
    ])('executes %s', (command, expected) => {
        const execute = vi.fn(() => ({ ok: true }))
        expect(executeFrontendCommand({ command }, execute)).toEqual({ ok: true })
        expect(execute).toHaveBeenCalledExactlyOnceWith(expected, { readOnly: false })
    })

    it('preserves quoted literal operators and escaped quotes as data', () => {
        const execute = vi.fn()
        executeFrontendCommand({ command: 'readback ask "What is \\"$HOME; <a>\\"?"' }, execute)
        expect(execute).toHaveBeenCalledWith({ action: 'answer_readback', question: 'What is "$HOME; <a>"?' }, { readOnly: false })
    })

    it.each(['help', 'help draft', 'draft --help', 'draft language --help'])('returns generated help without side effects: %s', command => {
        const execute = vi.fn()
        expect(executeFrontendCommand({ command }, execute)).toEqual({ ok: true, help: expect.stringContaining('draft language <original|zh|en>') })
        expect(execute).not.toHaveBeenCalled()
    })

    it.each([
        'rm -rf /', 'draft language fr', 'draft choose 0', 'draft choose 5', 'draft pending include 0', 'draft delay 61', 'draft alternatives', 'draft alternatives off extra',
        'draft auto-send on 0', 'draft auto-send on 61', 'mic sensitivity 101', 'session select 0',
        'session suggest q a b c d e f', 'draft alternatives off; voice reset', 'readback stop | voice reset',
        'readback ask $(whoami)', 'readback ask `whoami`', 'session list > file', 'session list "unclosed',
        'session list trailing\\', '',
    ])('rejects invalid or shell commands without partial execution: %s', command => {
        const execute = vi.fn()
        expect(() => executeFrontendCommand({ command }, execute)).toThrow()
        expect(execute).not.toHaveBeenCalled()
    })

    it('rejects the former tool arguments and documents every command group', () => {
        expect(() => executeFrontendCommand({ action: 'reset_voice' }, vi.fn())).toThrow()
        for (const group of ['draft', 'readback', 'session', 'voice', 'mic']) expect(frontendCommandHelp()).toContain(`${group} `)
    })
})


it('puts only frequently used commands in the AI prompt summary', () => {
    const summary = frontendCommandSummary()
    expect(summary).toContain('draft language <original|zh|en>')
    expect(summary).toContain('draft alternatives <on|off>')
    expect(summary).toContain('draft send')
    expect(summary).toContain('help <group>')
    expect(summary).not.toContain('readback output <')
    expect(frontendCommandHelp()).toContain('readback output <')
    expect(summary.length).toBeLessThan(frontendCommandHelp().length)
})

it.each(['ui status', 'readback devices'])('marks %s as read-only', command => {
    const execute = vi.fn()
    executeFrontendCommand({ command }, execute)
    expect(execute).toHaveBeenCalledWith(expect.any(Object), { readOnly: true })
})
