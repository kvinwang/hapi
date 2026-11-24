import type { VoiceUsage } from '@hapi/protocol/voiceUsage'

type Counts = Omit<VoiceUsage, 'model'>
type Details = { text_tokens?: number; audio_tokens?: number }

const FLUSH_MS = 10_000
/** PCM16 mono at 16 kHz, the capture format of every voice connection. */
const BYTES_PER_SECOND = 32_000

const zero = (): Counts => ({ audioSeconds: 0, inputTextTokens: 0, inputAudioTokens: 0, outputTextTokens: 0, outputAudioTokens: 0, characters: 0 })

let pending = new Map<string, Counts>()
let target: { baseUrl: string; token: string } | null = null
let timer: ReturnType<typeof setTimeout> | undefined

function flush(): void {
    timer = undefined
    if (!target || pending.size === 0) return
    const batch = pending
    pending = new Map()
    void fetch(`${target.baseUrl}/api/voice/usage`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
        body: JSON.stringify({ usage: [...batch].map(([model, counts]) => ({ model, ...counts })) })
    }).then((response) => {
        if (response.status >= 500) throw new Error(String(response.status))
    }).catch(() => batch.forEach((counts, model) => record(model, counts)))
}

function record(model: string, counts: Partial<Counts>): void {
    const total = pending.get(model) ?? zero()
    for (const key of Object.keys(counts) as Array<keyof Counts>) total[key] += counts[key] ?? 0
    pending.set(model, total)
    timer ??= setTimeout(flush, FLUSH_MS)
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { clearTimeout(timer); flush() })

/** Meters what one DashScope connection bills, reported to the hub in batches. */
export function voiceUsageMeter(model: string, hub: { baseUrl: string; token: string }) {
    target = hub
    return {
        base64Audio: (audio: string) => record(model, { audioSeconds: audio.length * 3 / 4 / BYTES_PER_SECOND }),
        text: (text: string) => record(model, { characters: text.length }),
        /** `usage` of a realtime `response.done`; DashScope bills output text only when no audio comes with it. */
        response: (usage: unknown) => {
            const u = usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: Details; output_tokens_details?: Details } | undefined
            if (!u) return
            const inputAudioTokens = u.input_tokens_details?.audio_tokens ?? 0
            const outputAudioTokens = u.output_tokens_details?.audio_tokens ?? 0
            record(model, {
                inputTextTokens: u.input_tokens_details?.text_tokens ?? (u.input_tokens ?? 0) - inputAudioTokens,
                inputAudioTokens,
                outputTextTokens: outputAudioTokens ? 0 : u.output_tokens_details?.text_tokens ?? u.output_tokens ?? 0,
                outputAudioTokens
            })
        }
    }
}
