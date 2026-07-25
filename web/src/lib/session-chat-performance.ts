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

function isEnabled(): boolean {
    if (typeof window === 'undefined') return false
    const queryEnabled = new URLSearchParams(window.location.search).get('chatPerf') === '1'
    return queryEnabled || window.localStorage.getItem('hapi.chatPerf') === '1'
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
