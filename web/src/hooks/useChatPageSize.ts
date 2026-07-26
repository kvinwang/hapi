import { useCallback, useEffect, useState } from 'react'
import {
    CHAT_PAGE_SIZE_OPTIONS,
    DEFAULT_CHAT_PAGE_SIZE,
    isChatPageSize,
    type ChatPageSize
} from '@hapi/protocol/chat'

/**
 * How many blocks one history request asks for. Read outside React too — the
 * message window store needs the current value at request time, not at render
 * time — so the storage read stays a plain function.
 */
const STORAGE_KEY = 'hapi-chat-page-size'

export function getChatPageSizeOptions(): ReadonlyArray<{ value: ChatPageSize; label: string }> {
    return CHAT_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: String(value) }))
}

function isBrowser(): boolean {
    return typeof window !== 'undefined'
}

function parseChatPageSize(raw: string | null): ChatPageSize {
    const value = Number(raw)
    return isChatPageSize(value) ? value : DEFAULT_CHAT_PAGE_SIZE
}

export function getChatPageSize(): ChatPageSize {
    if (!isBrowser()) {
        return DEFAULT_CHAT_PAGE_SIZE
    }
    try {
        return parseChatPageSize(localStorage.getItem(STORAGE_KEY))
    } catch {
        return DEFAULT_CHAT_PAGE_SIZE
    }
}

export function useChatPageSize(): { chatPageSize: ChatPageSize; setChatPageSize: (size: ChatPageSize) => void } {
    const [chatPageSize, setChatPageSizeState] = useState<ChatPageSize>(getChatPageSize)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }
        const onStorage = (event: StorageEvent) => {
            if (event.key !== STORAGE_KEY) {
                return
            }
            setChatPageSizeState(parseChatPageSize(event.newValue))
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setChatPageSize = useCallback((size: ChatPageSize) => {
        setChatPageSizeState(size)
        if (!isBrowser()) {
            return
        }
        try {
            if (size === DEFAULT_CHAT_PAGE_SIZE) {
                localStorage.removeItem(STORAGE_KEY)
            } else {
                localStorage.setItem(STORAGE_KEY, String(size))
            }
        } catch {
            // Storage is optional; the value still applies to this tab.
        }
    }, [])

    return { chatPageSize, setChatPageSize }
}
