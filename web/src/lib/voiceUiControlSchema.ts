import { z } from 'zod'

export const voiceUiControlSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list_sessions'), query: z.string().trim().min(1).max(160).optional() }),
    z.object({ action: z.literal('stop_readback') }),
    z.object({ action: z.literal('answer_readback'), question: z.string().trim().min(1).max(2000) }),
    z.object({ action: z.literal('replay_readback'), focus: z.string().trim().min(1).max(500).optional() }),
    z.object({ action: z.literal('switch_session'), sessionId: z.string().min(1) }),
    z.object({ action: z.literal('suggest_sessions'), sessionIds: z.array(z.string().min(1)).max(5), query: z.string().trim().min(1).max(160) }),
    z.object({ action: z.literal('reset_voice') }),
    z.object({ action: z.literal('select_session'), index: z.number().int().min(1).max(5) }),
    z.object({ action: z.literal('cancel_selection') }),
    z.object({ action: z.literal('readback_language'), language: z.enum(['zh', 'en']) }),
    z.object({ action: z.literal('readback'), enabled: z.boolean() }),
    z.object({ action: z.literal('auto_send'), enabled: z.boolean().optional(), delay: z.number().int().min(1).max(60).optional() }).refine(value => value.enabled !== undefined || value.delay !== undefined),
    z.object({ action: z.literal('draft_panel'), open: z.boolean() }),
    z.object({ action: z.literal('draft_language'), language: z.enum(['original', 'zh', 'en']) }),
    z.object({ action: z.literal('draft_alternatives'), enabled: z.boolean() }),
    z.object({ action: z.literal('draft_mode'), mode: z.enum(['auto', 'manual']) }),
    z.object({ action: z.literal('mic_sensitivity'), value: z.number().int().min(0).max(100) })
])
export type VoiceUiControl = z.infer<typeof voiceUiControlSchema>
