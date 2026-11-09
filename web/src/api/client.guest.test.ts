import { afterEach, expect, it, vi } from 'vitest'
import { ApiClient } from './client'

afterEach(() => vi.unstubAllGlobals())
it('pins guest API requests to the current guest token even if owner cookies exist', async () => {
    let token = 'guest-test-token'
    const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(JSON.stringify({ threadIds: [], allowAgents: false, sessionId: 'root' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = new ApiClient({ baseUrl: 'https://test.invalid', getAccessToken: () => token })
    await api.getGuestScope()
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer guest-test-token')
    token = 'refreshed-guest-test-token'
    await api.getGuestScope()
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
        'Bearer refreshed-guest-test-token'
    )
})
