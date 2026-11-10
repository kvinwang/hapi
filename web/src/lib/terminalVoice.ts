import { useSyncExternalStore } from 'react'

const EXECUTE_KEY = 'hapi.voiceTerminalExecute'
const EXECUTE_EVENT = 'hapi-voice-terminal-execute'

export function getVoiceTerminalExecute(): boolean {
    try { return localStorage.getItem(EXECUTE_KEY) === '1' } catch { return false }
}

export function setVoiceTerminalExecute(execute: boolean): void {
    try { localStorage.setItem(EXECUTE_KEY, execute ? '1' : '0') } catch { /* Preference is optional. */ }
    window.dispatchEvent(new Event(EXECUTE_EVENT))
}

export function useVoiceTerminalExecute(): boolean {
    return useSyncExternalStore(listener => {
        window.addEventListener(EXECUTE_EVENT, listener)
        return () => window.removeEventListener(EXECUTE_EVENT, listener)
    }, getVoiceTerminalExecute, () => false)
}

/** Keep a draft from accidentally submitting multiple lines or injecting terminal control keys. */
export function terminalVoiceInput(command: string, execute: boolean): string {
    const text = command.trim()
    if (!text || /[\x00-\x1f\x7f\u2028\u2029]/.test(text)) throw new Error('terminalSingleLine')
    return text + (execute ? '\r' : '')
}
