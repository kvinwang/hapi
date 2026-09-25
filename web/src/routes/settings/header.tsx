import type { ReactNode } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useWorkspaceLayout } from '@/hooks/useWorkspaceLayout'
import { useTranslation } from '@/lib/use-translation'

function BackIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

export const headerIconButtonClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]'

/** Levels below `/settings`: 0 for the category list, 1 for a group, 2 for a managed resource. */
export function settingsDepth(pathname: string): number {
    return pathname.replace(/\/+$/, '').split('/').length - 2
}

/**
 * Header shared by every settings page. Back goes to the logical parent; with
 * the category nav on screen a group page has no parent to show, so it hides.
 */
export function SettingsPageHeader(props: { title: string; action?: ReactNode; onBack?: () => void }) {
    const { t } = useTranslation()
    const goBack = useAppGoBack()
    const { settingsNav } = useWorkspaceLayout()
    const pathname = useLocation({ select: (location) => location.pathname })
    const showBack = props.onBack !== undefined || settingsNav === 'drilldown' || settingsDepth(pathname) >= 2

    return (
        <div className="border-b border-[var(--app-border)] bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
            <div className="mx-auto flex h-14 w-full max-w-content items-center gap-2 px-3">
                {showBack && (
                    <button type="button" onClick={props.onBack ?? goBack} className={headerIconButtonClass} aria-label={t('session.back')}>
                        <BackIcon />
                    </button>
                )}
                <h1 className="min-w-0 flex-1 truncate font-semibold">{props.title}</h1>
                {props.action}
            </div>
        </div>
    )
}

/** Header plus a scrolling, content-width body. */
export function SettingsScreen(props: { title: string; action?: ReactNode; children: ReactNode }) {
    return (
        <div className="flex h-full min-h-0 flex-col">
            <SettingsPageHeader title={props.title} action={props.action} />
            <div className="min-h-0 flex-1 overflow-y-auto app-scroll-y">
                <div className="mx-auto w-full max-w-content pb-[env(safe-area-inset-bottom)]">
                    {props.children}
                </div>
            </div>
        </div>
    )
}
