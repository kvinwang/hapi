import { afterEach, expect, it, vi } from 'vitest'
import { acquireReadbackTurn } from './readbackQueue'

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

it('serializes different readers until the previous audio is released', async () => {
    const first = new AbortController(), second = new AbortController()
    const release = await acquireReadbackTurn(first.signal, () => true)
    let acquired = false
    const next = acquireReadbackTurn(second.signal, () => true).then(value => { acquired = true; return value })
    await Promise.resolve()
    expect(acquired).toBe(false)
    release!()
    const finish = await next
    expect(acquired).toBe(true)
    finish!()
})

it('cancels queued items and rechecks eligibility after waiting', async () => {
    const first = new AbortController(), canceled = new AbortController(), inactive = new AbortController()
    const release = await acquireReadbackTurn(first.signal, () => true)
    const pending = acquireReadbackTurn(canceled.signal, () => true)
    let allowed = true
    const skipped = acquireReadbackTurn(inactive.signal, () => allowed)
    canceled.abort()
    expect(await pending).toBeNull()
    allowed = false
    release!()
    expect(await skipped).toBeNull()
})

it('deduplicates messages from different tabs while permitting retries by the same owner', async () => {
    const release = await acquireReadbackTurn(new AbortController().signal, () => true, 'message', 'tab-a')
    release!()
    expect(await acquireReadbackTurn(new AbortController().signal, () => true, 'message', 'tab-b')).toBeNull()
    const retry = await acquireReadbackTurn(new AbortController().signal, () => true, 'message', 'tab-a')
    expect(retry).not.toBeNull()
    retry!()
})

it('uses the origin-wide browser lock and releases it on cancellation', async () => {
    const calls: string[] = []
    const request = vi.fn(async (name: string, _options: LockOptions, callback: () => Promise<void>) => {
        calls.push('locked')
        await callback()
        calls.push('released')
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const controller = new AbortController()
    const release = await acquireReadbackTurn(controller.signal, () => true)
    expect(request.mock.calls[0][0]).toBe('hapi-readback-playback')
    expect(calls).toEqual(['locked'])
    controller.abort()
    await vi.waitFor(() => expect(calls).toEqual(['locked', 'released']))
    release!()
})

it('lets another tab retry a message when the first reader failed', async () => {
    const failed = await acquireReadbackTurn(new AbortController().signal, () => true, 'retry-message', 'tab-a')
    failed!(true)
    const next = await acquireReadbackTurn(new AbortController().signal, () => true, 'retry-message', 'tab-b')
    expect(next).not.toBeNull()
    next!()
})
