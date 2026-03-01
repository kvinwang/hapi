import { useMemo } from 'react'
import { AttachmentPrimitive, useThreadComposerAttachment } from '@assistant-ui/react'
import { Spinner } from '@/components/Spinner'
import { ImageLightbox } from '@/components/ui/ImageLightbox'

function ErrorIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
    )
}

function RemoveIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
    )
}

export function AttachmentItem() {
    const { name, contentType, file, status } = useThreadComposerAttachment()
    const isUploading = status.type === 'running'
    const isError = status.type === 'incomplete'
    const isImage = contentType?.startsWith('image/')

    const previewUrl = useMemo(() => {
        if (isImage && file) {
            return URL.createObjectURL(file)
        }
        return undefined
    }, [isImage, file])

    if (isImage && previewUrl) {
        return (
            <AttachmentPrimitive.Root className="relative inline-block rounded-lg bg-[var(--app-subtle-bg)] text-base text-[var(--app-fg)]">
                <ImageLightbox src={previewUrl} alt={name}>
                    <div className="relative overflow-hidden rounded-lg">
                        <img
                            src={previewUrl}
                            alt={name}
                            className="h-20 max-w-[160px] object-cover rounded-lg"
                        />
                        {isUploading && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-lg">
                                <Spinner size="sm" label={null} className="text-white" />
                            </div>
                        )}
                    </div>
                </ImageLightbox>
                <AttachmentPrimitive.Remove
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--app-secondary-bg)] text-[var(--app-hint)] shadow-sm transition-colors hover:text-[var(--app-fg)]"
                    aria-label="Remove attachment"
                    title="Remove attachment"
                >
                    <RemoveIcon />
                </AttachmentPrimitive.Remove>
            </AttachmentPrimitive.Root>
        )
    }

    return (
        <AttachmentPrimitive.Root className="flex items-center gap-2 rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-base text-[var(--app-fg)]">
            {isUploading ? <Spinner size="sm" label={null} className="text-[var(--app-hint)]" /> : null}
            {isError ? (
                <span className="text-red-500">
                    <ErrorIcon />
                </span>
            ) : null}
            <span className="max-w-[150px] truncate">{name}</span>
            <AttachmentPrimitive.Remove
                className="ml-auto flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                aria-label="Remove attachment"
                title="Remove attachment"
            >
                <RemoveIcon />
            </AttachmentPrimitive.Remove>
        </AttachmentPrimitive.Root>
    )
}
