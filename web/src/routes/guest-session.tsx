import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClient, ApiError } from '@/api/client'
import { LoadingState } from '@/components/LoadingState'
import { ToastContainer } from '@/components/ToastContainer'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useSSE } from '@/hooks/useSSE'
import { AppContextProvider } from '@/lib/app-context'
import { catchUpMessagesAfterReconnect, clearMessageWindow, fetchLatestMessages } from '@/lib/message-window-store'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import type { GuestInfo, SyncEvent } from '@/types/api'

function tokenKey(baseUrl: string, grantId: string): string {
    return `hapi_guest_token::${baseUrl}::${grantId}`
}

export function readCode(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

export function writeCode(key: string, code: string | null): void {
    try {
        if (code) localStorage.setItem(key, code)
        else localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

export function GuestCodePrompt(props: { error: boolean; onSubmit: (code: string) => void; title?: string; subtitle?: string; errorText?: string; children?: ReactNode }) {
    const { t } = useTranslation()
    const [code, setCode] = useState('')

    const handleSubmit = (event: FormEvent) => {
        event.preventDefault()
        if (code.trim()) props.onSubmit(code.trim())
    }

    return (
        <div className="h-full flex flex-col items-center justify-center gap-8 overflow-y-auto p-4">
            <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
                <div className="text-center space-y-2">
                    <div className="text-2xl font-semibold">{props.title ?? t('guest.title')}</div>
                    <div className="text-sm text-[var(--app-hint)]">{props.subtitle ?? t('guest.subtitle')}</div>
                </div>
                <input
                    type="text"
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    placeholder={t('guest.codePlaceholder')}
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    autoFocus
                    className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-center font-mono tracking-widest text-[var(--app-fg)] placeholder:text-[var(--app-hint)] placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                />
                {props.error ? (
                    <div className="text-sm text-red-500 text-center">{props.errorText ?? t('guest.error.invalid')}</div>
                ) : null}
                <button
                    type="submit"
                    disabled={!code.trim()}
                    className="w-full py-2.5 rounded-lg bg-[var(--app-button)] text-[var(--app-button-text)] font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                    {t('guest.submit')}
                </button>
            </form>
            {props.children}
        </div>
    )
}

function GuestSessionLive(props: {
    api: ApiClient
    baseUrl: string
    token: string
    guest: GuestInfo
    children: ReactNode
}) {
    const { api, guest } = props
    const queryClient = useQueryClient()

    const handleConnect = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.session(guest.sessionId) })
        void catchUpMessagesAfterReconnect(api, guest.sessionId)
    }, [api, guest.sessionId, queryClient])

    const handleEvent = useCallback(
        (event: SyncEvent) => {
            if (event.type !== 'messages-trimmed' || event.sessionId !== guest.sessionId) return
            clearMessageWindow(event.sessionId)
            void fetchLatestMessages(api, event.sessionId)
        },
        [api, guest.sessionId]
    )

    useEffect(() => {
        const timer = setInterval(() => {
            void queryClient.invalidateQueries({ queryKey: ['threads'] })
            void queryClient.invalidateQueries({ queryKey: queryKeys.session(guest.sessionId) })
        }, 5_000)
        return () => clearInterval(timer)
    }, [queryClient, guest.sessionId])

    const subscription = useMemo(() => ({ sessionId: guest.sessionId }), [guest.sessionId])
    useSSE({
        enabled: true,
        baseUrl: props.baseUrl,
        accessToken: props.token,
        subscription,
        onConnect: handleConnect,
        onEvent: handleEvent
    })

    return <>{props.children}</>
}

function GuestAuthenticated(props: {
    grantId: string
    token: string
    baseUrl: string
    onRejected: () => void
    children: (sessionId: string) => ReactNode
}) {
    const { t } = useTranslation()
    const { grantId, token, baseUrl, onRejected } = props
    const api = useMemo(() => new ApiClient({ baseUrl, getAccessToken: () => token }), [baseUrl, token])
    // Polling the scope notices revocation, expiry and renewal, and keeps capabilities current.
    const scope = useQuery({
        queryKey: ['guest-scope', grantId],
        queryFn: () => api.getGuestScope(),
        refetchInterval: 5_000,
        retry: false
    })
    const failure = scope.error instanceof ApiError ? scope.error : null

    useEffect(() => {
        if (failure?.status === 401) onRejected()
    }, [failure, onRejected])

    if (failure?.code === 'guest_expired') {
        return <p role="alert" className="p-8 text-center">{t('guest.error.expired')}</p>
    }

    if (scope.error)
        return (
            <div className="p-4">
                <p role="alert">{t('guest.error.invalid')}</p>
                <button onClick={() => void scope.refetch()}>{t('sessions.refresh')}</button>
            </div>
        )

    if (!scope.data) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('authorizing')} className="text-sm" />
            </div>
        )
    }

    const guest = { ...scope.data, grantId }
    return (
        <AppContextProvider value={{ api, token, baseUrl, guest }}>
            <GuestSessionLive api={api} baseUrl={baseUrl} token={token} guest={guest}>
                <div className="h-full min-h-0 flex flex-col">{props.children(guest.sessionId)}</div>
            </GuestSessionLive>
            <ToastContainer />
        </AppContextProvider>
    )
}

/**
 * Entry point for a guest code and its scoped collaboration views. The code is single-use, so it is
 * redeemed once and only the resulting token is kept. A separate query cache and explicit guest
 * credentials keep owner state out of the guest shell.
 */
export function GuestSessionShell(props: { grantId: string; children: (sessionId: string) => ReactNode }) {
    const { t } = useTranslation()
    const { baseUrl } = useServerUrl()
    const queryClient = useMemo(
        () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        [baseUrl, props.grantId]
    )
    useEffect(() => () => queryClient.clear(), [queryClient])
    const storageKey = tokenKey(baseUrl, props.grantId)
    const [token, setToken] = useState(() => readCode(storageKey))
    const [error, setError] = useState<string | null>(null)
    const [redeeming, setRedeeming] = useState(false)

    const submitCode = (code: string) => {
        if (redeeming) return
        setRedeeming(true)
        new ApiClient({ baseUrl }).authenticate({ guestGrantId: props.grantId, code })
            .then(auth => {
                writeCode(storageKey, auth.token)
                setError(null)
                setToken(auth.token)
            })
            .catch(e => setError(e instanceof ApiError && e.status === 401 ? t('guest.error.invalid') : String(e)))
            .finally(() => setRedeeming(false))
    }

    const reject = useCallback(() => {
        queryClient.clear()
        writeCode(storageKey, null)
        setError(t('guest.error.ended'))
        setToken(null)
    }, [queryClient, storageKey, t])

    if (!token) {
        return <GuestCodePrompt error={error !== null} errorText={error ?? undefined} onSubmit={submitCode} />
    }

    // Keyed by token, so a new one never sees the previous one's auth error.
    return (
        <QueryClientProvider client={queryClient}>
            <GuestAuthenticated
                key={token}
                grantId={props.grantId}
                token={token}
                baseUrl={baseUrl}
                onRejected={reject}
            >
                {props.children}
            </GuestAuthenticated>
        </QueryClientProvider>
    )
}
