import type { ApiClient } from '@/api/client'

/** Operations required by voice drafting and readback, independent of the conversation kind. */
export type VoiceApi = Pick<ApiClient,
    'getOmniVoiceSession' | 'runVoiceDraft' | 'getMessages' | 'sendMessage' | 'resumeSession' | 'interruptSession' | 'reportVoiceEvent'
>
