import { useSyncExternalStore } from 'react'

export type SessionHeaderStyle = 'auto' | 'compact' | 'expanded'
export type SessionHeaderPosition = 'auto' | 'top' | 'bottom'
const STORAGE_KEY = 'hapi.sessionHeaderStyle'
const POSITION_KEY = 'hapi.sessionHeaderPosition'
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


function readPosition(): SessionHeaderPosition {
    try {
        const value = localStorage.getItem(POSITION_KEY)
        return value === 'top' || value === 'bottom' ? value : 'auto'
    } catch {
        return 'auto'
    }
}

export function useSessionHeaderPosition() {
    const headerPosition = useSyncExternalStore(subscribe, readPosition, () => 'auto' as const)
    const setHeaderPosition = (value: SessionHeaderPosition) => {
        try {
            localStorage.setItem(POSITION_KEY, value)
        } catch {
            return
        }
        window.dispatchEvent(new Event(CHANGE_EVENT))
    }
    return { headerPosition, setHeaderPosition }
}
