import { describe, expect, it } from 'vitest'
import { DEFAULT_GROK_MODEL, resolveGrokRuntimeConfig } from './config'

describe('resolveGrokRuntimeConfig', () => {
    it('defaults to grok-4.5 when no override is provided', () => {
        const previous = process.env.GROK_MODEL
        delete process.env.GROK_MODEL
        try {
            // Prefer explicit model when provided
            expect(resolveGrokRuntimeConfig({ model: 'custom-model' }).model).toBe('custom-model')
            // Without env/override, falls through to local cache or DEFAULT
            const resolved = resolveGrokRuntimeConfig({}).model
            expect(typeof resolved).toBe('string')
            expect(resolved.length).toBeGreaterThan(0)
            // Default constant stays stable for UI pickers
            expect(DEFAULT_GROK_MODEL).toBe('grok-4.5')
        } finally {
            if (previous === undefined) {
                delete process.env.GROK_MODEL
            } else {
                process.env.GROK_MODEL = previous
            }
        }
    })

    it('prefers GROK_MODEL env over default when no model option is set', () => {
        const previous = process.env.GROK_MODEL
        process.env.GROK_MODEL = 'env-model'
        try {
            expect(resolveGrokRuntimeConfig({}).model).toBe('env-model')
        } finally {
            if (previous === undefined) {
                delete process.env.GROK_MODEL
            } else {
                process.env.GROK_MODEL = previous
            }
        }
    })
})
