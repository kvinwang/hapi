type AudioSession = { type: string }
const owners = new WeakMap<AudioSession, { count: number; previous: string }>()

/** Keep one automatic category for capture and playback instead of switching it for every utterance. */
export function createVoiceAudioSession() {
    const session = (navigator as Navigator & { audioSession?: AudioSession }).audioSession
    let released = false
    if (session) {
        const state = owners.get(session)
        if (state) state.count++
        else {
            owners.set(session, { count: 1, previous: session.type })
            try { session.type = 'auto' } catch { /* The browser may not support category selection. */ }
        }
    }
    return {
        get type() { return session?.type ?? 'unsupported' },
        restore() {
            if (!session || released) return
            released = true
            const state = owners.get(session)
            if (!state || --state.count) return
            owners.delete(session)
            try { if (session.type === 'auto') session.type = state.previous } catch {}
        }
    }
}
