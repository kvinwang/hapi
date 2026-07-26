import { useEffect, useRef, useState, type ReactNode } from 'react'

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

export function SettingsSection(props: { title: string; description?: string; children: ReactNode }) {
    return (
        <section className="border-b border-[var(--app-divider)]">
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
