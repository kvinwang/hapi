type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record'
type AudioSession = { type: AudioSessionType }

export function createVoiceAudioSession() {
    const session = (navigator as Navigator & { audioSession?: AudioSession }).audioSession
    const previousType = session?.type ?? 'auto'
    let requestedType: AudioSessionType | undefined

    const setType = (type: AudioSessionType) => {
        if (!session) return
        try {
            session.type = type
            requestedType = type
        } catch {
            // An unsupported audio category must not prevent recording or playback.
        }
    }

    return {
        get type() { return session?.type ?? 'unsupported' },
        setMicrophoneActive(active: boolean) {
            setType(active ? 'play-and-record' : 'playback')
        },
        restore() {
            if (session && session.type === requestedType) setType(previousType)
        }
    }
}
