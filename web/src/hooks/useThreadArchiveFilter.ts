import { useSyncExternalStore } from 'react'

const KEY = 'hapi-threads-hide-archived'
const EVENT = 'hapi-thread-archive-filter'
function subscribe(listener: () => void) {
    window.addEventListener('storage', listener)
    window.addEventListener(EVENT, listener)
    return () => {
        window.removeEventListener('storage', listener)
        window.removeEventListener(EVENT, listener)
    }
}
function snapshot(): boolean {
    try { return localStorage.getItem(KEY) !== 'false' } catch { return true }
}
export function useThreadArchiveFilter() {
    const hideArchived = useSyncExternalStore(subscribe, snapshot, () => true)
    const toggleArchived = () => {
        try { localStorage.setItem(KEY, String(!snapshot())) } catch { return }
        window.dispatchEvent(new Event(EVENT))
    }
    return { hideArchived, toggleArchived }
}
