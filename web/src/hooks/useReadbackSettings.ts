import { useSyncExternalStore } from 'react'

export type ReadbackLanguage = 'zh' | 'en'
const ENABLED = 'hapi.aiReadbackEnabled'
const LANGUAGE = 'hapi.readbackLanguage'
const OWN_MESSAGES = 'hapi.readbackOwnMessages'
const FINAL_ONLY = 'hapi.readbackFinalOnly'
const EVENT = 'hapi-readback-settings'

function read(key: string): string {
    try { return localStorage.getItem(key) ?? '' } catch { return '' }
}
function subscribe(listener: () => void) {
    window.addEventListener('storage', listener)
    window.addEventListener(EVENT, listener)
    return () => {
        window.removeEventListener('storage', listener)
        window.removeEventListener(EVENT, listener)
    }
}
function save(key: string, value: string) {
    try { localStorage.setItem(key, value) } catch { return }
    window.dispatchEvent(new Event(EVENT))
}
export function useReadbackSettings() {
    const enabled = useSyncExternalStore(subscribe, () => read(ENABLED), () => '') === 'true'
    const storedLanguage = useSyncExternalStore(subscribe, () => read(LANGUAGE), () => '')
    const language: ReadbackLanguage = storedLanguage === 'en' ? 'en' : 'zh'
    const ownMessages = useSyncExternalStore(subscribe, () => read(OWN_MESSAGES), () => '') === 'true'
    const finalOnly = useSyncExternalStore(subscribe, () => read(FINAL_ONLY), () => '') === 'true'
    return {
        enabled, language, ownMessages, finalOnly,
        setFinalOnly: (value: boolean) => save(FINAL_ONLY, String(value)),
        setEnabled: (value: boolean) => save(ENABLED, String(value)),
        setOwnMessages: (value: boolean) => save(OWN_MESSAGES, String(value)),
        setLanguage: (value: ReadbackLanguage) => save(LANGUAGE, value)
    }
}
