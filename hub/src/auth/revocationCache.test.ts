import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RevocationCache } from './revocationCache'
import { AuthService } from './authService'
import { hashApiKey } from '../utils/apiKey'

describe('revocation closes established connections', () => {
    it('closes all key connections, including derived tokens, while retaining other keys', () => {
        const store = new Store(':memory:')
        const cache = new RevocationCache(store.accessTokens, store.apiKeys)
        const closed: string[] = []
        cache.trackConnection('key-a', null, () => closed.push('cli'))
        cache.trackConnection('key-a', 'token-a', () => closed.push('terminal'))
        cache.trackConnection('key-a', null, () => { throw new Error('Already closed') })
        cache.trackConnection('key-a', 'token-b', () => closed.push('sse'))
        cache.trackConnection('key-b', null, () => closed.push('other'))
        cache.revokeApiKey('key-a')
        cache.revokeApiKey('key-a')
        expect(closed).toEqual(['cli', 'terminal', 'sse'])
        cache.trackConnection('key-a', null, () => closed.push('handshake-race'))
        expect(closed.at(-1)).toBe('handshake-race')
    })
    it('isolates access-token revocation and unregisters disconnected clients', () => {
        const store = new Store(':memory:')
        const cache = new RevocationCache(store.accessTokens, store.apiKeys)
        const closed: string[] = []
        const release = cache.trackConnection('key', 'gone', () => closed.push('gone'))
        release()
        cache.trackConnection('key', 'first', () => closed.push('first'))
        cache.trackConnection('key', 'second', () => closed.push('second'))
        cache.revokeAccessToken('first')
        expect(closed).toEqual(['first'])
        cache.revokeApiKey('key')
        expect(closed).toEqual(['first', 'second'])
    })
    it('does not let a revoked database key fall through to legacy authentication', () => {
        const store = new Store(':memory:')
        const raw = 'test-only-legacy-token'
        store.apiKeys.createApiKey({ id: 'legacy', name: 'test', keyHash: hashApiKey(raw), keyPrefix: 'test', namespace: 'default', permissions: ['admin'] })
        const cache = new RevocationCache(store.accessTokens, store.apiKeys)
        const service = new AuthService(store, cache, new Uint8Array(32), raw)
        expect(service.authenticateCliToken(raw)).not.toBeNull()
        store.apiKeys.revokeApiKey('legacy')
        expect(service.authenticateCliToken(raw)).toBeNull()
    })
})
