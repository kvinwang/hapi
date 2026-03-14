import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'code-word-wrap'
const listeners = new Set<() => void>()
let wordWrap = localStorage.getItem(STORAGE_KEY) === 'true'

// Initialize data attribute on load
if (wordWrap) document.documentElement.setAttribute('data-code-wrap', '')

function subscribe(callback: () => void): () => void {
    listeners.add(callback)
    return () => listeners.delete(callback)
}

function getSnapshot(): boolean {
    return wordWrap
}

export function toggleWordWrap(): void {
    wordWrap = !wordWrap
    localStorage.setItem(STORAGE_KEY, String(wordWrap))
    if (wordWrap) {
        document.documentElement.setAttribute('data-code-wrap', '')
    } else {
        document.documentElement.removeAttribute('data-code-wrap')
    }
    for (const listener of listeners) listener()
}

export function useWordWrap(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
