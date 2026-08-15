import { useCallback, useMemo, useState } from 'react'

const HUB_URL_KEY = 'hapi_hub_url'

function getDefaultServerUrl(): string | null {
    const configured = import.meta.env.VITE_DEFAULT_HUB_URL
    if (!configured) return null
    const normalized = normalizeServerUrl(configured)
    return normalized.ok ? normalized.value : null
}

/**
 * Base URL for content owned by the hub that served the page — public share links, and
 * anything else addressed by a token that only one hub can resolve.
 *
 * Deliberately ignores the stored hub override and URL params that `getInitialBaseUrl`
 * honours: those express *this viewer's* choice of hub, which is the wrong question here.
 * A share token is only valid on the hub that issued it, so letting a visitor's saved
 * `hapi_hub_url` win would send the lookup to their hub and 404 a perfectly good link.
 */
export function getPublicContentBaseUrl(): string {
    return getDefaultServerUrl() ?? (typeof window !== 'undefined' ? window.location.origin : '')
}

export type ServerUrlResult =
    | { ok: true; value: string }
    | { ok: false; error: string }

export function normalizeServerUrl(input: string): ServerUrlResult {
    const trimmed = input.trim()
    if (!trimmed) {
        return { ok: false, error: 'Enter a hub URL like https://example.com' }
    }

    let parsed: URL
    try {
        parsed = new URL(trimmed)
    } catch {
        return { ok: false, error: 'Enter a valid URL including http:// or https://' }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Hub URL must start with http:// or https://' }
    }

    return { ok: true, value: parsed.origin }
}

function getServerFromUrlParams(): string | null {
    if (typeof window === 'undefined') return null
    const query = new URLSearchParams(window.location.search)
    const hub = query.get('hub')
    if (hub) {
        const normalized = normalizeServerUrl(hub)
        return normalized.ok ? normalized.value : null
    }
    return null
}

function readStoredServerUrl(): string | null {
    try {
        const stored = localStorage.getItem(HUB_URL_KEY)
        if (!stored) {
            return null
        }
        const normalized = normalizeServerUrl(stored)
        if (!normalized.ok) {
            localStorage.removeItem(HUB_URL_KEY)
            return null
        }
        return normalized.value
    } catch {
        return null
    }
}

/**
 * The base URL the app will use, resolved without React so work that has to happen before the first
 * render (restoring the persisted query cache) can key off the same value `useServerUrl` settles on.
 */
export function getInitialBaseUrl(): string {
    if (typeof window === 'undefined') {
        return ''
    }
    return getServerFromUrlParams() ?? readStoredServerUrl() ?? getDefaultServerUrl() ?? window.location.origin
}

function writeStoredServerUrl(value: string): void {
    try {
        localStorage.setItem(HUB_URL_KEY, value)
    } catch {
        // Ignore storage errors
    }
}

function clearStoredServerUrl(): void {
    try {
        localStorage.removeItem(HUB_URL_KEY)
    } catch {
        // Ignore storage errors
    }
}

export function useServerUrl(): {
    serverUrl: string | null
    baseUrl: string
    setServerUrl: (input: string) => ServerUrlResult
    clearServerUrl: () => void
} {
    const [serverUrl, setServerUrlState] = useState<string | null>(() => {
        // Priority: URL params > localStorage
        const fromUrl = getServerFromUrlParams()
        if (fromUrl) {
            writeStoredServerUrl(fromUrl) // Save to localStorage for refresh
            return fromUrl
        }
        return readStoredServerUrl()
    })

    const fallbackOrigin = getDefaultServerUrl() ?? (typeof window !== 'undefined' ? window.location.origin : '')
    const baseUrl = useMemo(() => serverUrl ?? fallbackOrigin, [serverUrl, fallbackOrigin])

    const setServerUrl = useCallback((input: string): ServerUrlResult => {
        const normalized = normalizeServerUrl(input)
        if (!normalized.ok) {
            return normalized
        }
        writeStoredServerUrl(normalized.value)
        setServerUrlState(normalized.value)
        return normalized
    }, [])

    const clearServerUrl = useCallback(() => {
        clearStoredServerUrl()
        setServerUrlState(null)
    }, [])

    return {
        serverUrl,
        baseUrl,
        setServerUrl,
        clearServerUrl
    }
}
