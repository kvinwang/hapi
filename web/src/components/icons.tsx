import type { ReactNode } from 'react'

type IconProps = {
    className?: string
}

function createIcon(paths: ReactNode, props: IconProps, strokeWidth = 1.5) {
    return (
        <svg
            className={props.className ?? 'h-4 w-4'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {paths}
        </svg>
    )
}

export function CloseIcon(props: IconProps) {
    return createIcon(
        <path d="M6 18 18 6M6 6l12 12" />,
        props,
        2
    )
}

export function ShareIcon(props: IconProps) {
    return createIcon(
        <path d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15m0-3-3-3m0 0-3 3m3-3v12" />,
        props
    )
}

export function PlusCircleIcon(props: IconProps) {
    return createIcon(
        <path d="M12 9v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
        props
    )
}

export function CopyIcon(props: IconProps) {
    return createIcon(
        <>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>,
        props,
        2
    )
}

export function WrapIcon(props: IconProps) {
    return createIcon(
        <>
            <line x1="3" y1="6" x2="21" y2="6" />
            <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
            <polyline points="16 16 14 18 16 20" />
            <line x1="3" y1="18" x2="10" y2="18" />
        </>,
        props,
        2
    )
}

export function CheckIcon(props: IconProps) {
    return createIcon(
        <polyline points="20 6 9 17 4 12" />,
        props,
        2
    )
}

/** Arrow into a line: jump to the newest message. */
export function ArrowDownToLineIcon(props: IconProps) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={props.className} aria-hidden="true"
        >
            <path d="M12 4v10" />
            <path d="m7 11 5 5 5-5" />
            <path d="M5 20h14" />
        </svg>
    )
}
