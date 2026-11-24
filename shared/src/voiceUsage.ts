import { z } from 'zod'

/** Billable DashScope voice usage, as metered by the browser for one model. */
export const voiceUsageSchema = z.object({
    model: z.string().trim().min(1).max(100),
    responses: z.number().int().nonnegative(),
    audioSeconds: z.number().finite().nonnegative(),
    inputTextTokens: z.number().int().nonnegative(),
    inputAudioTokens: z.number().int().nonnegative(),
    outputTextTokens: z.number().int().nonnegative(),
    outputAudioTokens: z.number().int().nonnegative(),
    characters: z.number().int().nonnegative()
})

export type VoiceUsage = z.infer<typeof voiceUsageSchema>
export type VoiceUsageCounts = Omit<VoiceUsage, 'model'>

export const voiceUsageReportSchema = z.object({ usage: z.array(voiceUsageSchema).max(20) })

/** A billed quantity: the usage field it reads, its price in CNY and how many units that price covers. */
export type VoicePriceLine = { field: keyof VoiceUsageCounts; price: number; per: number }

const perMillion = (field: keyof VoiceUsageCounts, price: number): VoicePriceLine => ({ field, price, per: 1_000_000 })

/** Model Studio Beijing (dashscope.aliyuncs.com) list prices, before discounts. */
export const VOICE_PRICES: Record<string, VoicePriceLine[]> = {
    'qwen3.8-omni-flash-realtime': [
        perMillion('inputAudioTokens', 6), perMillion('inputTextTokens', 1.5),
        perMillion('outputTextTokens', 4.5), perMillion('outputAudioTokens', 12)
    ],
    // Earlier rows: text that came with audio output was free and is not in outputTextTokens.
    'qwen3.5-omni-plus-realtime': [
        perMillion('inputAudioTokens', 80), perMillion('inputTextTokens', 10),
        perMillion('outputTextTokens', 60), perMillion('outputAudioTokens', 300)
    ],
    'qwen3-asr-flash-realtime': [{ field: 'audioSeconds', price: 0.00033, per: 1 }],
    'qwen3-tts-flash-realtime': [{ field: 'characters', price: 1, per: 10_000 }]
}

export const voiceLineCost = (usage: VoiceUsageCounts, line: VoicePriceLine): number => usage[line.field] * line.price / line.per

export function voiceUsageCost(usage: VoiceUsage): number {
    return (VOICE_PRICES[usage.model] ?? []).reduce((sum, line) => sum + voiceLineCost(usage, line), 0)
}

/** DashScope realtime model behind each voice connection kind; the relay serves kind `k` at `/<k>-relay`. */
export const VOICE_MODELS = {
    omni: 'qwen3.8-omni-flash-realtime',
    tts: 'qwen3-tts-flash-realtime',
    asr: 'qwen3-asr-flash-realtime'
} as const

export type VoiceConnectionKind = keyof typeof VOICE_MODELS
