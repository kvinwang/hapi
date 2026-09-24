import type { PiPermissionMode } from '@hapi/protocol/types'

export type PermissionMode = PiPermissionMode

export interface PiMode {
    permissionMode: PermissionMode
    model?: string
    effort?: string
    appendSystemPrompt?: string
}
