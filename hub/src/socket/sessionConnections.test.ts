import { describe, expect, it } from 'bun:test'
import { SessionConnections } from './sessionConnections'

describe('SessionConnections', () => {
    it('keeps a resumed connection current when the replaced connection ends late', () => {
        const connections = new SessionConnections()

        connections.claim('session-1', 'old-socket')
        connections.claim('session-1', 'new-socket')

        expect(connections.isCurrent('session-1', 'old-socket')).toBe(false)
        expect(connections.isCurrent('session-1', 'new-socket')).toBe(true)

        connections.release('session-1', 'old-socket')
        expect(connections.isCurrent('session-1', 'new-socket')).toBe(true)
    })
})
