import { z } from 'zod'

/** Billable DashScope voice usage, as metered by the browser for one model. */
export const voiceUsageSchema = z.object({
    model: z.string().trim().min(1).max(100),
    audioSeconds: z.number().finite().nonnegative(),
    inputTextTokens: z.number().int().nonnegative(),
    inputAudioTokens: z.number().int().nonnegative(),
    outputTextTokens: z.number().int().nonnegative(),
    outputAudioTokens: z.number().int().nonnegative(),
    characters: z.number().int().nonnegative()
})

export type VoiceUsage = z.infer<typeof voiceUsageSchema>

export const voiceUsageReportSchema = z.object({ usage: z.array(voiceUsageSchema).max(20) })

/** Cost in CNY per unit; list prices of Model Studio Beijing (dashscope.aliyuncs.com), before discounts. */
type VoicePrice = { perSecond?: number; perTenThousandChars?: number; perMillion?: { inputText: number; inputAudio: number; outputText: number; outputAudio: number } }

export const VOICE_PRICES: Record<string, VoicePrice> = {
    'qwen3.5-omni-plus-realtime': { perMillion: { inputText: 10, inputAudio: 80, outputText: 60, outputAudio: 300 } },
    'qwen3-asr-flash-realtime': { perSecond: 0.00033 },
    'qwen3-tts-flash-realtime': { perTenThousandChars: 1 },
    'paraformer-realtime-v2': { perSecond: 0.00024 }
}

export function voiceUsageCost(usage: VoiceUsage): number | null {
    const price = VOICE_PRICES[usage.model]
    if (!price) return null
    const tokens = price.perMillion
    return (price.perSecond ?? 0) * usage.audioSeconds
        + (price.perTenThousandChars ?? 0) * usage.characters / 10_000
        + (tokens
            ? (tokens.inputText * usage.inputTextTokens + tokens.inputAudio * usage.inputAudioTokens
                + tokens.outputText * usage.outputTextTokens + tokens.outputAudio * usage.outputAudioTokens) / 1_000_000
            : 0)
}

/** DashScope models behind each voice connection, on the hub pipe and the relays alike. */
export const VOICE_MODELS = {
    omni: 'qwen3.5-omni-plus-realtime',
    tts: 'qwen3-tts-flash-realtime',
    asr: 'qwen3-asr-flash-realtime',
    dictation: 'paraformer-realtime-v2'
} as const
