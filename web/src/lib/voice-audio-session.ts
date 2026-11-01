type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record'
type AudioSession = { type: AudioSessionType }
type Requests = { previous: AudioSessionType; applied?: AudioSessionType; owners: Map<symbol, AudioSessionType> }
const sessions = new WeakMap<AudioSession, Requests>()

function audioSessionRequest() {
    const session = (navigator as Navigator & { audioSession?: AudioSession }).audioSession
    const owner = Symbol()
    const apply = (requests: Requests, type: AudioSessionType) => {
        if (!session) return
        try { session.type = type; requests.applied = type } catch { /* Unsupported categories must not stop audio. */ }
    }
    const update = (type: AudioSessionType) => {
        if (!session) return
        const requests = sessions.get(session) ?? { previous: session.type, owners: new Map<symbol, AudioSessionType>() }
        sessions.set(session, requests)
        requests.owners.set(owner, type)
        apply(requests, [...requests.owners.values()].includes('play-and-record') ? 'play-and-record' : 'playback')
    }
    const restore = () => {
        if (!session) return
        const requests = sessions.get(session)
        if (!requests?.owners.delete(owner)) return
        if (requests.owners.size) {
            apply(requests, [...requests.owners.values()].includes('play-and-record') ? 'play-and-record' : 'playback')
        } else {
            if (session.type === requests.applied) apply(requests, requests.previous)
            sessions.delete(session)
        }
    }
    return { update, restore, get type() { return session?.type ?? 'unsupported' } }
}

export function createVoiceAudioSession() {
    const request = audioSessionRequest()
    return {
        get type() { return request.type },
        setMicrophoneActive(active: boolean) { request.update(active ? 'play-and-record' : 'playback') },
        restore: request.restore
    }
}

export function createPlaybackAudioSession() {
    const request = audioSessionRequest()
    request.update('playback')
    return request
}
