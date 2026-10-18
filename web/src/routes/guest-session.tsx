import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { LoadingState } from '@/components/LoadingState'
import { ToastContainer } from '@/components/ToastContainer'
import { useAuth, type AuthSource } from '@/hooks/useAuth'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useSSE } from '@/hooks/useSSE'
import { AppContextProvider } from '@/lib/app-context'
import { catchUpMessagesAfterReconnect, clearMessageWindow, fetchLatestMessages } from '@/lib/message-window-store'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import type { GuestInfo, SyncEvent } from '@/types/api'

function codeKey(baseUrl: string, grantId: string): string {
    return `hapi_guest_code::${baseUrl}::${grantId}`
}

function readCode(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function writeCode(key: string, code: string | null): void {
    try {
        if (code) localStorage.setItem(key, code)
        else localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

function GuestCodePrompt(props: { error: boolean; onSubmit: (code: string) => void }) {
    const { t } = useTranslation()
    const [code, setCode] = useState('')

    const handleSubmit = (event: FormEvent) => {
        event.preventDefault()
        if (code.trim()) props.onSubmit(code.trim())
    }

    return (
        <div className="h-full flex items-center justify-center p-4">
            <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
                <div className="text-center space-y-2">
                    <div className="text-2xl font-semibold">{t('guest.title')}</div>
                    <div className="text-sm text-[var(--app-hint)]">{t('guest.subtitle')}</div>
                </div>
                <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={t('guest.codePlaceholder')}
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    autoFocus
                    className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-center font-mono tracking-widest text-[var(--app-fg)] placeholder:text-[var(--app-hint)] placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                />
                {props.error ? (
                    <div className="text-sm text-red-500 text-center">{t('guest.error.invalid')}</div>
                ) : null}
                <button
                    type="submit"
                    disabled={!code.trim()}
                    className="w-full py-2.5 rounded-lg bg-[var(--app-button)] text-[var(--app-button-text)] font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                    {t('guest.submit')}
                </button>
            </form>
        </div>
    )
}

function GuestSessionLive(props: { api: ApiClient; baseUrl: string; guest: GuestInfo; children: ReactNode }) {
    const { api, guest } = props
    const queryClient = useQueryClient()

    const handleConnect = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.session(guest.sessionId) })
        void catchUpMessagesAfterReconnect(api, guest.sessionId)
    }, [api, guest.sessionId, queryClient])

    const handleEvent = useCallback((event: SyncEvent) => {
        if (event.type !== 'messages-trimmed' || event.sessionId !== guest.sessionId) return
        clearMessageWindow(event.sessionId)
        void fetchLatestMessages(api, event.sessionId)
    }, [api, guest.sessionId])

    const subscription = useMemo(() => ({ sessionId: guest.sessionId }), [guest.sessionId])
    useSSE({ enabled: true, baseUrl: props.baseUrl, subscription, onConnect: handleConnect, onEvent: handleEvent })

    return <>{props.children}</>
}

function GuestAuthenticated(props: {
    grantId: string
    code: string
    baseUrl: string
    onRejected: () => void
    children: (sessionId: string) => ReactNode
}) {
    const { t } = useTranslation()
    const { grantId, code, baseUrl, onRejected } = props
    const authSource = useMemo<AuthSource>(() => ({ type: 'guest', grantId, code }), [grantId, code])
    const { token, api, guest, error } = useAuth(authSource, baseUrl)

    // A wrong, expired or revoked code.
    useEffect(() => {
        if (error && !token) onRejected()
    }, [error, token, onRejected])

    if (!token || !api || !guest) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('authorizing')} className="text-sm" />
            </div>
        )
    }

    return (
        <AppContextProvider value={{ api, token, baseUrl, guest }}>
            <GuestSessionLive api={api} baseUrl={baseUrl} guest={guest}>
                <div className="h-full min-h-0 flex flex-col">
                    {props.children(guest.sessionId)}
                </div>
            </GuestSessionLive>
            <ToastContainer />
        </AppContextProvider>
    )
}

/**
 * Entry point for a guest link: asks for the access code, then renders the one session the
 * grant covers. Lives outside the main app shell, so no session list, settings or owner-only
 * UI is ever mounted for a guest.
 */
export function GuestSessionShell(props: { grantId: string; children: (sessionId: string) => ReactNode }) {
    const { baseUrl } = useServerUrl()
    const storageKey = codeKey(baseUrl, props.grantId)
    const [code, setCode] = useState(() => readCode(storageKey))
    const [rejected, setRejected] = useState(false)

    const submitCode = useCallback((value: string) => {
        writeCode(storageKey, value)
        setRejected(false)
        setCode(value)
    }, [storageKey])

    const rejectCode = useCallback(() => {
        writeCode(storageKey, null)
        setRejected(true)
        setCode(null)
    }, [storageKey])

    if (!code) {
        return <GuestCodePrompt error={rejected} onSubmit={submitCode} />
    }

    // Keyed by code, so a new attempt never sees the previous attempt's auth error.
    return (
        <GuestAuthenticated key={code} grantId={props.grantId} code={code} baseUrl={baseUrl} onRejected={rejectCode}>
            {props.children}
        </GuestAuthenticated>
    )
}
