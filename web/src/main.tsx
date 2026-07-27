import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import './index.css'
import { registerSW } from 'virtual:pwa-register'
import { initializeFontScale } from '@/hooks/useFontScale'
import { getTelegramWebApp, isTelegramEnvironment, loadTelegramSdk } from './hooks/useTelegram'
import { queryClient } from './lib/query-client'
import { createAppRouter } from './router'
import { I18nProvider } from './lib/i18n-context'
import { restoreSpaRedirect } from './lib/spaRedirect'
import { restoreQueryCache } from './lib/query-persist'
import { getInitialBaseUrl } from './hooks/useServerUrl'
import { setRestoredCacheUserId } from './lib/query-client'

function getStartParam(): string | null {
    const query = new URLSearchParams(window.location.search)
    const fromQuery = query.get('startapp') || query.get('tgWebAppStartParam')
    if (fromQuery) return fromQuery

    return getTelegramWebApp()?.initDataUnsafe?.start_param ?? null
}

function getDeepLinkedSessionId(): string | null {
    const startParam = getStartParam()
    if (startParam?.startsWith('session_')) {
        return startParam.slice('session_'.length)
    }
    return null
}

function getInitialPath(): string {
    const sessionId = getDeepLinkedSessionId()
    return sessionId ? `/sessions/${sessionId}` : '/sessions'
}

async function bootstrap() {
    initializeFontScale()

    // Warm the cache from disk before the first render so a cold start (an installed PWA reopened
    // hours later) paints the sessions list immediately instead of a spinner. Bounded internally by
    // a timeout, so a slow or wedged IndexedDB cannot delay startup.
    const restored = await restoreQueryCache(queryClient, getInitialBaseUrl())
    setRestoredCacheUserId(restored.userId)

    // Only load Telegram SDK in Telegram environment (with 3s timeout)
    const isTelegram = isTelegramEnvironment()
    document.documentElement.dataset.telegramApp = isTelegram ? 'true' : 'false'
    if (isTelegram) {
        await loadTelegramSdk()
    }

    // Handle GitHub Pages 404 redirect for SPA routing
    // When GitHub Pages can't find a path (e.g. /sessions/xxx), it serves 404.html
    // which stores the path in sessionStorage and redirects to /
    if (!isTelegram) {
        restoreSpaRedirect()
    }

    const updateSW = registerSW({
        onNeedRefresh() {
            if (confirm('New version available! Reload to update?')) {
                updateSW(true)
            }
        },
        onOfflineReady() {
            console.log('App ready for offline use')
        },
        onRegistered(registration) {
            if (!registration) {
                return
            }

            // Re-check for a new service worker periodically, and whenever the app comes back
            // to the foreground or regains connectivity — an installed PWA can stay open for
            // days, so a timer alone leaves users on a stale build for far too long.
            const check = () => {
                if (document.visibilityState === 'visible' && navigator.onLine) {
                    void registration.update()
                }
            }

            setInterval(check, 15 * 60 * 1000)
            document.addEventListener('visibilitychange', check)
            window.addEventListener('online', check)
        },
        onRegisterError(error) {
            console.error('SW registration error:', error)
        }
    })

    const history = isTelegram
        ? createMemoryHistory({ initialEntries: [getInitialPath()] })
        : undefined
    const router = createAppRouter(history)

    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <I18nProvider>
                <QueryClientProvider client={queryClient}>
                    <RouterProvider router={router} />
                    {import.meta.env.DEV ? <ReactQueryDevtools initialIsOpen={false} /> : null}
                </QueryClientProvider>
            </I18nProvider>
        </React.StrictMode>
    )

    dismissAppShell()
}

/**
 * Drop the static shell from index.html once React has painted over it. Waits two frames so the
 * first commit is on screen — removing it earlier just swaps one blank page for another.
 */
function dismissAppShell(): void {
    const shell = document.getElementById('app-shell')
    if (!shell) {
        return
    }
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            shell.style.opacity = '0'
            setTimeout(() => shell.remove(), 150)
        })
    })
}

bootstrap()
