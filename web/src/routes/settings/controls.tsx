import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { activeSectionId } from '@/routes/settings/sectionIndex'

/**
 * The building blocks of the settings page. Every row is label-left,
 * value-right; every group carries one heading. Keeping them here is what stops
 * the page from growing a fifth hand-rolled dropdown.
 */

const ROW_CLASS = 'flex w-full items-center justify-between px-3 py-3 text-left transition-colors'
const ROW_HOVER = 'hover:bg-[var(--app-subtle-bg)]'

function CheckIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    )
}

function ChevronDownIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    )
}

function ChevronRightIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

/**
 * Sticky list of the groups below, doubling as a jump target. The page stays one
 * scroll — this only saves the reader from hunting through nine headings.
 */
export function SettingsIndexBar(props: {
    sections: ReadonlyArray<{ id: string; label: string }>
    scrollRef: RefObject<HTMLDivElement | null>
}) {
    const [active, setActive] = useState<string | null>(props.sections[0]?.id ?? null)
    const barRef = useRef<HTMLDivElement>(null)
    const trackRef = useRef<HTMLDivElement>(null)
    const chipRefs = useRef(new Map<string, HTMLButtonElement>())
    /** A jump the reader asked for, held until the smooth scroll settles. The
     * last groups cannot reach the top of a bottom-clamped scroller, so the
     * measured answer would disagree with what they just tapped. */
    const pinnedRef = useRef<{ id: string; until: number } | null>(null)

    /**
     * Offset of a section inside the scroller. Measured from the rects rather
     * than offsetTop, which is relative to whichever ancestor happens to be
     * positioned and would put every jump off by the app header.
     */
    const sectionTop = (container: HTMLElement, element: HTMLElement) => (
        element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    )

    useEffect(() => {
        const container = props.scrollRef.current
        if (!container) return

        let frame: number | null = null
        const measure = () => {
            frame = null
            const offsets = props.sections
                .map((section) => {
                    const element = container.querySelector<HTMLElement>(`[data-settings-section="${section.id}"]`)
                    return element ? { id: section.id, offsetTop: sectionTop(container, element) } : null
                })
                .filter((entry): entry is { id: string; offsetTop: number } => entry !== null)
            const pinned = pinnedRef.current
            if (pinned && performance.now() < pinned.until) {
                setActive(pinned.id)
                return
            }
            setActive(activeSectionId(offsets, container.scrollTop, barRef.current?.offsetHeight ?? 0))
        }

        const onScroll = () => {
            if (frame !== null) return
            frame = requestAnimationFrame(measure)
        }

        measure()
        container.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            container.removeEventListener('scroll', onScroll)
            if (frame !== null) cancelAnimationFrame(frame)
        }
    }, [props.scrollRef, props.sections])

    // Keep the highlighted chip in view; the bar scrolls sideways on a phone.
    // Scroll the strip itself rather than calling scrollIntoView, which walks up
    // to the page scroller and cancels a jump that is still animating.
    useEffect(() => {
        const chip = active ? chipRefs.current.get(active) : null
        const track = trackRef.current
        // jsdom has no scrollTo; the strip simply does not scroll under test.
        if (!chip || typeof track?.scrollTo !== 'function') return
        track.scrollTo({
            left: Math.max(0, chip.offsetLeft - (track.clientWidth - chip.clientWidth) / 2),
            behavior: 'smooth'
        })
    }, [active])

    const jumpTo = (id: string) => {
        const container = props.scrollRef.current
        const target = container?.querySelector<HTMLElement>(`[data-settings-section="${id}"]`)
        if (!container || !target) return
        pinnedRef.current = { id, until: performance.now() + 1_000 }
        setActive(id)
        container.scrollTo({
            top: Math.max(0, sectionTop(container, target) - (barRef.current?.offsetHeight ?? 0)),
            behavior: 'smooth'
        })
    }

    return (
        <div
            ref={barRef}
            className="sticky top-0 z-20 border-b border-[var(--app-divider)] bg-[var(--app-bg)]/95 backdrop-blur"
        >
            <div
                ref={trackRef}
                className="flex gap-1 overflow-x-auto px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                {props.sections.map((section) => {
                    const isActive = section.id === active
                    return (
                        <button
                            key={section.id}
                            ref={(node) => {
                                if (node) chipRefs.current.set(section.id, node)
                                else chipRefs.current.delete(section.id)
                            }}
                            type="button"
                            onClick={() => jumpTo(section.id)}
                            aria-current={isActive ? 'true' : undefined}
                            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                                isActive
                                    ? 'bg-[var(--app-link)] text-white'
                                    : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                            }`}
                        >
                            {section.label}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}

export function SettingsSection(props: { id?: string; title: string; description?: string; children: ReactNode }) {
    return (
        <section id={props.id} data-settings-section={props.id} className="border-b border-[var(--app-divider)]">
            <h2 className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {props.title}
            </h2>
            {props.description ? (
                <p className="px-3 pb-2 text-xs text-[var(--app-hint)]">{props.description}</p>
            ) : null}
            {props.children}
        </section>
    )
}

/** Label plus a value that opens a list of choices. Owns its own popover. */
export function SettingsSelectRow<T extends string | number | null>(props: {
    label: string
    valueLabel: string
    options: ReadonlyArray<{ value: T; label: string }>
    selected: T
    onSelect: (value: T) => void
    /** Wider popover for long option labels. */
    wide?: boolean
}) {
    const [isOpen, setIsOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!isOpen) return
        const onPointerDown = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false)
            }
        }
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onEscape)
        return () => {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onEscape)
        }
    }, [isOpen])

    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className={`${ROW_CLASS} ${ROW_HOVER}`}
                aria-expanded={isOpen}
                aria-haspopup="listbox"
            >
                <span className="text-[var(--app-fg)]">{props.label}</span>
                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                    <span>{props.valueLabel}</span>
                    <ChevronDownIcon className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </span>
            </button>

            {isOpen && (
                <div
                    className={`absolute right-3 top-full z-50 mt-1 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg ${props.wide ? 'max-h-64 min-w-[200px] overflow-y-auto' : 'min-w-[140px]'}`}
                    role="listbox"
                    aria-label={props.label}
                >
                    {props.options.map((option) => {
                        const isSelected = option.value === props.selected
                        return (
                            <button
                                key={String(option.value)}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                onClick={() => {
                                    props.onSelect(option.value)
                                    setIsOpen(false)
                                }}
                                className={`flex w-full items-center justify-between px-3 py-2 text-left text-base transition-colors ${
                                    isSelected
                                        ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]'
                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                }`}
                            >
                                <span>{option.label}</span>
                                {isSelected && <span className="ml-2 text-[var(--app-link)]"><CheckIcon /></span>}
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

export function SettingsToggleRow(props: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={props.checked}
            onClick={() => props.onChange(!props.checked)}
            className={`${ROW_CLASS} ${ROW_HOVER}`}
        >
            <span className="text-[var(--app-fg)]">{props.label}</span>
            <span
                className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full transition-colors ${
                    props.checked ? 'bg-[var(--app-link)]' : 'bg-[var(--app-border)]'
                }`}
            >
                <span
                    className={`pointer-events-none mt-[2px] inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                        props.checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
                    }`}
                />
            </span>
        </button>
    )
}

/** Row that navigates somewhere else. */
export function SettingsLinkRow(props: { label: string; onClick: () => void }) {
    return (
        <button type="button" onClick={props.onClick} className={`${ROW_CLASS} ${ROW_HOVER}`}>
            <span className="text-[var(--app-fg)]">{props.label}</span>
            <ChevronRightIcon className="text-[var(--app-hint)]" />
        </button>
    )
}

/** Read-only row: a label and whatever the value happens to be. */
export function SettingsInfoRow(props: { label: string; children: ReactNode }) {
    return (
        <div className={ROW_CLASS}>
            <span className="text-[var(--app-fg)]">{props.label}</span>
            {props.children}
        </div>
    )
}
