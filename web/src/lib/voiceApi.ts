import type { ApiClient } from '@/api/client'

/** Operations required by dictation and readback, independent of the conversation kind. */
export type VoiceApi = Pick<ApiClient,
    'getOmniVoiceSession' | 'getMessages' | 'sendMessage' | 'resumeSession' | 'interruptSession' | 'reportVoiceEvent'
>
