import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { useSendMessage } from './useSendMessage'

vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { notification: vi.fn() } }) }))

describe('useSendMessage', () => {
    it('delivers back-to-back sends in order instead of dropping the second', async () => {
        const delivered: string[] = []
        let releaseFirst: () => void = () => {}
        const api = {
            sendMessage: vi.fn(async (_sessionId: string, text: string) => {
                if (text === '/clear') await new Promise<void>((resolve) => { releaseFirst = resolve })
                delivered.push(text)
            })
        } as unknown as ApiClient
        const client = new QueryClient()
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        )
        const { result } = renderHook(() => useSendMessage(api, 'session-1', {
            resolveSessionId: async (id) => id
        }), { wrapper })

        result.current.sendMessage('/clear')
        result.current.sendMessage('~ hello')

        await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
        releaseFirst()
        await waitFor(() => expect(delivered).toEqual(['/clear', '~ hello']))
    })
})
