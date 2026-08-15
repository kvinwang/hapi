import { describe, expect, it, beforeEach } from 'vitest'
import { getInitialBaseUrl, getPublicContentBaseUrl } from './useServerUrl'

/**
 * These two look interchangeable and are not. `getInitialBaseUrl` answers "which hub is
 * this viewer using", `getPublicContentBaseUrl` answers "which hub owns this content" —
 * and a public share link is the case where confusing them silently 404s a valid link.
 */

describe('getPublicContentBaseUrl', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('falls back to the serving origin', () => {
        expect(getPublicContentBaseUrl()).toBe(window.location.origin)
    })

    it("ignores the viewer's own stored hub", () => {
        // The regression: a share token only resolves on the hub that issued it, so
        // anyone who had ever pointed the app at another hub got a 404 on valid links.
        localStorage.setItem('hapi_hub_url', 'https://someone-elses-hub.example.com')
        expect(getPublicContentBaseUrl()).toBe(window.location.origin)
    })
})

describe('getInitialBaseUrl', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('honours the stored hub, which is the whole point of the hub picker', () => {
        localStorage.setItem('hapi_hub_url', 'https://my-hub.example.com')
        expect(getInitialBaseUrl()).toBe('https://my-hub.example.com')
    })

    it('falls back to the serving origin when nothing is stored', () => {
        expect(getInitialBaseUrl()).toBe(window.location.origin)
    })
})
