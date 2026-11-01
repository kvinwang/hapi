import { useSyncExternalStore } from 'react'

export type SessionHeaderStyle = 'auto' | 'compact' | 'expanded'
const STORAGE_KEY = 'hapi.sessionHeaderStyle'
const CHANGE_EVENT = 'hapi-session-header-style'

function read(): SessionHeaderStyle {
    try {
        const value = localStorage.getItem(STORAGE_KEY)
        return value === 'compact' || value === 'expanded' ? value : 'auto'
    } catch {
        return 'auto'
    }
}

function subscribe(callback: () => void) {
    window.addEventListener('storage', callback)
    window.addEventListener(CHANGE_EVENT, callback)
    return () => {
        window.removeEventListener('storage', callback)
        window.removeEventListener(CHANGE_EVENT, callback)
    }
}

export function useSessionHeaderStyle() {
    const headerStyle = useSyncExternalStore(subscribe, read, () => 'auto' as const)
    const setHeaderStyle = (value: SessionHeaderStyle) => {
        try {
            localStorage.setItem(STORAGE_KEY, value)
        } catch {
            return
        }
        window.dispatchEvent(new Event(CHANGE_EVENT))
    }
    return { headerStyle, setHeaderStyle }
}
