import type { Attachment } from '@assistant-ui/react'

export function areComposerAttachmentsReady(attachments: readonly Attachment[]): boolean {
    return attachments.every((attachment) => (
        attachment.status.type === 'complete'
        || attachment.status.type === 'requires-action'
    ))
}
