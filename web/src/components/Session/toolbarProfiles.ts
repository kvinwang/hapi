import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ToolbarLayout } from './toolbarLayout'

export type ToolbarPreferences = { layout: ToolbarLayout; expanded: boolean; position: { x: number; y: number } }
type Profiles = { defaults: Partial<ToolbarPreferences>; screens: Record<string, Partial<ToolbarPreferences>> }
const KEY = 'hapi.toolbarProfiles'
const EVENT = 'hapi-toolbar-profiles'

function read(): string {
    try { return localStorage.getItem(KEY) ?? '' } catch { return '' }
}

function parse(raw: string): Profiles {
    try {
        const value = JSON.parse(raw)
        return { defaults: value.defaults ?? {}, screens: value.screens ?? {} }
    } catch {
        let defaults: Partial<ToolbarPreferences> = {}
        try {
            const layout = localStorage.getItem('hapi.toolbarLayout')
            const position = JSON.parse(localStorage.getItem('hapi.mobilePosition') ?? 'null')
            defaults = {
                layout: layout === 'left' || layout === 'right' ? layout : 'floating',
                expanded: localStorage.getItem('hapi.mobileTabsVisible') !== '0',
                ...(position && Number.isFinite(position.x) && Number.isFinite(position.y) ? { position } : {})
            }
        } catch { /* Defaults remain usable when storage is unavailable. */ }
        return { defaults, screens: {} }
    }
}

/** Layout width distinguishes folded displays; physical screen height ignores browser/keyboard chrome. */
export function toolbarScreenKey(): string {
    if (typeof window === 'undefined') return 'default'
    return `${Math.round(window.innerWidth)}x${Math.round(window.screen.height || window.innerHeight)}`
}

function subscribe(callback: () => void) {
    window.addEventListener('storage', callback)
    window.addEventListener(EVENT, callback)
    window.addEventListener('resize', callback)
    window.addEventListener('orientationchange', callback)
    window.screen.orientation?.addEventListener('change', callback)
    return () => {
        window.removeEventListener('storage', callback)
        window.removeEventListener(EVENT, callback)
        window.removeEventListener('resize', callback)
        window.removeEventListener('orientationchange', callback)
        window.screen.orientation?.removeEventListener('change', callback)
    }
}

export function useToolbarPreferences() {
    const raw = useSyncExternalStore(subscribe, read, () => '')
    const screenKey = useSyncExternalStore(subscribe, toolbarScreenKey, () => 'default')
    const preferences = useMemo<ToolbarPreferences>(() => {
        const profiles = parse(raw)
        const defaults: ToolbarPreferences = { layout: 'floating', expanded: true,
            position: { x: Math.max(8, window.innerWidth - 50), y: Math.max(80, window.innerHeight / 2 - 80) } }
        return { ...defaults, ...profiles.defaults, ...profiles.screens[screenKey] }
    }, [raw, screenKey])
    const update = useCallback((patch: Partial<ToolbarPreferences>) => {
        const profiles = parse(read())
        profiles.screens[screenKey] = { ...profiles.screens[screenKey], ...patch }
        try { localStorage.setItem(KEY, JSON.stringify(profiles)) } catch { return }
        window.dispatchEvent(new Event(EVENT))
    }, [screenKey])
    return { preferences, screenKey, update }
}
