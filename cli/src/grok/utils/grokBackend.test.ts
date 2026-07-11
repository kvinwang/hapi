import { describe, expect, it } from 'vitest'
import { createGrokBackend } from './grokBackend'

describe('createGrokBackend', () => {
    it('launches grok agent stdio with model', () => {
        const backend = createGrokBackend({ model: 'grok-4.5', cwd: '/tmp' })
        // Access private options via cast for smoke check of spawn args
        const options = (backend as unknown as {
            options: { command: string; args?: string[]; authMethodId?: string }
        }).options
        expect(options.command).toBe('grok')
        expect(options.args).toEqual(['agent', '--model', 'grok-4.5', 'stdio'])
        expect(options.authMethodId).toBe('auto')
    })

    it('passes --always-approve for bypassPermissions', () => {
        const backend = createGrokBackend({
            model: 'grok-4.5',
            permissionMode: 'bypassPermissions'
        })
        const options = (backend as unknown as { options: { command: string; args?: string[] } }).options
        expect(options.args).toEqual([
            'agent',
            '--model', 'grok-4.5',
            '--always-approve',
            'stdio'
        ])
    })
})
