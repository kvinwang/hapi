import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'code-word-wrap'
const listeners = new Set<() => void>()
let wordWrap = localStorage.getItem(STORAGE_KEY) === 'true'

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
    for (const listener of listeners) listener()
}

export function useWordWrap(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
