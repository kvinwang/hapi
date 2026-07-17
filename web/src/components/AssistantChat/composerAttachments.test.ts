import { describe, expect, it } from 'vitest'
import type { Attachment } from '@assistant-ui/react'
import { areComposerAttachmentsReady } from './composerAttachments'

function attachmentWithStatus(status: Attachment['status']): Attachment {
    return {
        id: 'attachment-1',
        type: 'file',
        name: 'image.png',
        contentType: 'image/png',
        status
    } as Attachment
}

describe('areComposerAttachmentsReady', () => {
    it('allows attachments waiting for composer send without custom fields', () => {
        const attachment = attachmentWithStatus({
            type: 'requires-action',
            reason: 'composer-send'
        })

        expect(areComposerAttachmentsReady([attachment])).toBe(true)
    })

    it('allows complete attachments', () => {
        expect(areComposerAttachmentsReady([
            attachmentWithStatus({ type: 'complete' })
        ])).toBe(true)
    })

    it('waits for uploads and rejects failed attachments', () => {
        expect(areComposerAttachmentsReady([
            attachmentWithStatus({ type: 'running', reason: 'uploading', progress: 50 })
        ])).toBe(false)
        expect(areComposerAttachmentsReady([
            attachmentWithStatus({ type: 'incomplete', reason: 'error' })
        ])).toBe(false)
    })
})
