import { z } from 'zod'
import { useEffect, useSyncExternalStore } from 'react'

const KEY = 'hapi.readbackSelection'
const EVENT = 'hapi-readback-selection'
const TAB = crypto.randomUUID()
const selectionSchema = z.object({ tab: z.string(), hub: z.string(), session: z.string() })
function read(): string {
    try { return localStorage.getItem(KEY) ?? '' } catch { return '' }
}
function selection(): { tab?: string; session?: string; hub?: string } {
    try { return selectionSchema.parse(JSON.parse(read())) } catch { return {} }
}
function subscribe(listener: () => void) {
    window.addEventListener('storage', listener)
    window.addEventListener(EVENT, listener)
    return () => {
        window.removeEventListener('storage', listener)
        window.removeEventListener(EVENT, listener)
    }
}
export function isSelectedReadbackConversation(hub: string, session: string): boolean {
    const current = selection()
    return current.hub === hub && current.session === session && (Boolean(navigator.locks) || current.tab === TAB)
}
export function isReadbackTab(): boolean { return selection().tab === TAB }
export function useReadbackSelection(hub: string, session: string): string {
    const value = useSyncExternalStore(subscribe, read, () => '')
    useEffect(() => {
        const claim = () => {
            try { localStorage.setItem(KEY, JSON.stringify({ tab: TAB, hub, session })) } catch { return }
            window.dispatchEvent(new Event(EVENT))
        }
        if (document.hasFocus() || !selection().tab || isReadbackTab()) claim()
        window.addEventListener('focus', claim)
        return () => window.removeEventListener('focus', claim)
    }, [hub, session])
    return value
}

export const READBACK_STOP = 'hapi.readbackStop'
export const READBACK_STOP_EVENT = 'hapi-readback-stop'
export function stopReadbackEverywhere(): void {
    try { localStorage.setItem(READBACK_STOP, crypto.randomUUID()) } catch {}
    window.dispatchEvent(new Event(READBACK_STOP_EVENT))
}
