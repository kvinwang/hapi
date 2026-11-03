import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { registerPlayback } from '@/lib/mediaPlayback'
import { useDictation } from './useDictation'

vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }) }))
vi.mock('@/lib/pcm16Worklet', () => ({ addPcm16Worklet: async () => ({ port: { onmessage: null } }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('starts dictation while media playback continues', async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia }, audioSession: { type: 'auto' } })
    vi.stubGlobal('AudioContext', class {
        close = async () => {}
        createMediaStreamSource = () => ({ connect: vi.fn() })
    })
    const playback = registerPlayback(vi.fn())
    const { result } = renderHook(() => useDictation({ baseUrl: '', token: '', onText: vi.fn(), onError: vi.fn() }))
    act(() => { void result.current.start() })
    expect(result.current.state).toBe('starting')
    await waitFor(() => expect(result.current.state).toBe('recording'))
    expect(getUserMedia).toHaveBeenCalledOnce()
    playback.release()
})
