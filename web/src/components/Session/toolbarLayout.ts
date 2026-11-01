import { useSyncExternalStore } from 'react'

export type ToolbarLayout = 'floating' | 'left' | 'right'
const STORAGE_KEY = 'hapi.toolbarLayout'
const CHANGE_EVENT = 'hapi-toolbar-layout'

function read(): ToolbarLayout {
    try {
        const value = localStorage.getItem(STORAGE_KEY)
        return value === 'left' || value === 'right' ? value : 'floating'
    } catch {
        return 'floating'
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

export function useToolbarLayout() {
    return useSyncExternalStore(subscribe, read, () => 'floating' as const)
}

export function setToolbarLayout(layout: ToolbarLayout): void {
    try { localStorage.setItem(STORAGE_KEY, layout) } catch { return }
    window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function toolbarDropLayout(x: number, y: number, left: number, right: number, top: number): ToolbarLayout {
    if (y < top || y > top + 96) return 'floating'
    if (x <= left + 32) return 'left'
    if (x >= right - 32) return 'right'
    return 'floating'
}
