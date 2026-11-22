const contexts = new Set<AudioContext>()

function open(): AudioContext[] {
    for (const audio of contexts) if (audio.state === 'closed') contexts.delete(audio)
    return [...contexts]
}

/** Tracks every page AudioContext: iOS WebKit renders them through one shared output, so a stalled one stalls all. */
export function createAudioContext(): AudioContext {
    open()
    const audio = new AudioContext()
    contexts.add(audio)
    return audio
}

export function audioContextStates(): string {
    return open().map((audio) => `${audio.state}@${audio.currentTime.toFixed(1)}`).join(',')
}

/** Restarts the shared output after an interruption. Works without a tap, as the contexts were already unlocked. */
export async function restartAudioContexts(): Promise<void> {
    const audios = open()
    const settle = (step: (audio: AudioContext) => Promise<void>) =>
        Promise.race([Promise.allSettled(audios.map(step)), new Promise((resolve) => setTimeout(resolve, 2000))])
    await settle((audio) => audio.suspend())
    await settle((audio) => audio.resume())
}
