import { describe, expect, it, beforeEach } from 'vitest'
import { DEFAULT_CHAT_PAGE_SIZE } from '@hapi/protocol/chat'
import { getChatPageSize, getChatPageSizeOptions } from './useChatPageSize'

describe('chat page size preference', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('falls back to the shared default the hub also applies', () => {
        expect(getChatPageSize()).toBe(DEFAULT_CHAT_PAGE_SIZE)
    })

    it('reads a stored choice', () => {
        localStorage.setItem('hapi-chat-page-size', '50')
        expect(getChatPageSize()).toBe(50)
    })

    it('ignores a value that is not on offer', () => {
        localStorage.setItem('hapi-chat-page-size', '37')
        expect(getChatPageSize()).toBe(DEFAULT_CHAT_PAGE_SIZE)
    })

    it('offers the sizes the hub accepts', () => {
        const values = getChatPageSizeOptions().map((option) => option.value)
        expect(values).toEqual([10, 20, 50, 100])
        expect(Math.max(...values)).toBeLessThanOrEqual(200)
    })
})
