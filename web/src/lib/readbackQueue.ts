const LOCK = 'hapi-readback-playback'
const SEEN = 'hapi.readbackSpoken'
let tail = Promise.resolve()

function claims(): Array<[string, string]> {
    try {
        const stored: unknown = JSON.parse(localStorage.getItem(SEEN) ?? '[]')
        if (Array.isArray(stored)) return stored.filter((entry): entry is [string, string] =>
            Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string'))
    } catch {}
    return []
}

/** Hold the origin-wide lock until the last PCM buffer ends, not just until generation finishes. */
export function acquireReadbackTurn(signal: AbortSignal, allowed: () => boolean, key?: string, owner = ''): Promise<((retryable?: boolean) => void) | null> {
    return new Promise(resolve => {
        let settled = false
        const finish = (value: ((retryable?: boolean) => void) | null) => {
            if (settled) return
            settled = true
            resolve(value)
        }
        const abort = () => finish(null)
        signal.addEventListener('abort', abort, { once: true })
        const run = async () => {
            if (signal.aborted || !allowed()) { finish(null); return }
            if (key) {
                const seen = claims()
                if (seen.some(([id, claimed]) => id === key && claimed !== owner)) { finish(null); return }
                try { localStorage.setItem(SEEN, JSON.stringify([...seen.filter(([id]) => id !== key), [key, owner]].slice(-1000))) } catch {}
            }
            await new Promise<void>(release => {
                let released = false
                const aborted = () => done()
                const done = (retryable = false) => {
                    if (released) return
                    released = true
                    if (retryable && key) {
                        try { localStorage.setItem(SEEN, JSON.stringify(claims().filter(([id, claimed]) => id !== key || claimed !== owner))) } catch {}
                    }
                    signal.removeEventListener('abort', aborted)
                    release()
                }
                signal.addEventListener('abort', aborted, { once: true })
                finish(done)
            })
        }
        const task = navigator.locks
            ? navigator.locks.request(LOCK, { signal }, run)
            : (tail = tail.catch(() => {}).then(run))
        void task.catch(() => finish(null)).finally(() => signal.removeEventListener('abort', abort))
    })
}
