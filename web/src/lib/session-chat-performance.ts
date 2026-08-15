export type SessionChatPerformanceSample = {
    count: number
    totalMs: number
    maxMs: number
    lastMs: number
}

export type SessionChatPerformanceSnapshot = Record<string, SessionChatPerformanceSample>

declare global {
    interface Window {
        __HAPI_CHAT_PERF__?: {
            enabled: boolean
            reset: () => void
            snapshot: () => SessionChatPerformanceSnapshot
        }
    }
}

const samples = new Map<string, SessionChatPerformanceSample>()

/**
 * Resolved once, on first use, instead of on every call.
 *
 * This is read on every measured stage and on every React commit, and it used to parse
 * the query string and hit localStorage each time — synchronous storage I/O in the middle
 * of the chat render path, paid even with instrumentation switched off.
 *
 * Memoised lazily rather than at module load because bootstrap rewrites the URL
 * (`restoreSpaRedirect`), so a module-load read could sample the pre-restore location.
 * By the time the chat first renders the URL has settled. Toggling still takes a reload,
 * which is how the flag was already used.
 */
let enabled: boolean | null = null

/** Whether chat performance instrumentation is on for this page load. */
export function isSessionChatPerfEnabled(): boolean {
    if (enabled === null) {
        enabled = typeof window !== 'undefined' && (
            new URLSearchParams(window.location.search).get('chatPerf') === '1'
            || window.localStorage.getItem('hapi.chatPerf') === '1'
        )
    }
    return enabled
}

function isEnabled(): boolean {
    return isSessionChatPerfEnabled()
}

function snapshot(): SessionChatPerformanceSnapshot {
    return Object.fromEntries(
        [...samples.entries()].map(([name, sample]) => [name, { ...sample }])
    )
}

function installBrowserApi(): boolean {
    if (!isEnabled()) return false
    if (!window.__HAPI_CHAT_PERF__) {
        window.__HAPI_CHAT_PERF__ = {
            enabled: true,
            reset: () => samples.clear(),
            snapshot
        }
    }
    return true
}

export function recordSessionChatDuration(name: string, durationMs: number): void {
    if (!installBrowserApi()) return
    const previous = samples.get(name)
    samples.set(name, {
        count: (previous?.count ?? 0) + 1,
        totalMs: (previous?.totalMs ?? 0) + durationMs,
        maxMs: Math.max(previous?.maxMs ?? 0, durationMs),
        lastMs: durationMs
    })
}

export function measureSessionChatStage<T>(name: string, run: () => T): T {
    if (!isEnabled()) return run()
    const startedAt = performance.now()
    try {
        return run()
    } finally {
        recordSessionChatDuration(name, performance.now() - startedAt)
    }
}
