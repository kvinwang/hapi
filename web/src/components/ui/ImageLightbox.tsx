import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface ImageLightboxProps {
    src: string
    alt?: string
    children: React.ReactNode
}

function CloseIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="5" y1="5" x2="15" y2="15" />
            <line x1="15" y1="5" x2="5" y2="15" />
        </svg>
    )
}

export function ImageLightbox({ src, alt, children }: ImageLightboxProps) {
    const [open, setOpen] = useState(false)

    const close = useCallback(() => setOpen(false), [])

    useEffect(() => {
        if (!open) return
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close()
        }
        document.addEventListener('keydown', handleKeyDown)
        document.body.style.overflow = 'hidden'
        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.body.style.overflow = ''
        }
    }, [open, close])

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="cursor-zoom-in appearance-none border-0 bg-transparent p-0"
            >
                {children}
            </button>
            {open && createPortal(
                <div
                    className="lightbox-overlay fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
                    onClick={close}
                >
                    <button
                        type="button"
                        onClick={close}
                        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                        aria-label="Close"
                    >
                        <CloseIcon />
                    </button>
                    <img
                        src={src}
                        alt={alt}
                        className="lightbox-image max-h-[90vh] max-w-[90vw] object-contain"
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>,
                document.body
            )}
        </>
    )
}
