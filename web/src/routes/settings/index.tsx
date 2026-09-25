import { useState, type ReactNode } from 'react'
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useWorkspaceLayout } from '@/hooks/useWorkspaceLayout'
import { useCredentials } from '@/hooks/queries/useCredentials'
import { useManagedMachines } from '@/hooks/queries/useMachines'
import { useApiKeys } from '@/hooks/queries/useApiKeys'
import { getAppearanceOptions } from '@/hooks/useTheme'
import { ChevronRightIcon, SettingsLogOutButton } from '@/routes/settings/controls'
import { SettingsPageHeader } from '@/routes/settings/header'
import { SettingsStateProvider, useSettingsState } from '@/routes/settings/state'
import { CATEGORY_ORDER, CATEGORY_TITLE_KEYS, entryPath, searchSettings, type SettingsCategoryId } from '@/routes/settings/catalog'
import GeneralSettings, { locales } from '@/routes/settings/sections/General'

function CategoryIcon(props: { children: ReactNode }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
            {props.children}
        </svg>
    )
}

const CATEGORY_ICONS: Record<SettingsCategoryId, ReactNode> = {
    general: (
        <CategoryIcon>
            <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
            <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
            <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
        </CategoryIcon>
    ),
    chat: (
        <CategoryIcon>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </CategoryIcon>
    ),
    models: (
        <CategoryIcon>
            <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
        </CategoryIcon>
    ),
    devices: (
        <CategoryIcon>
            <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
        </CategoryIcon>
    ),
    sessions: (
        <CategoryIcon>
            <polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" />
        </CategoryIcon>
    ),
    account: (
        <CategoryIcon>
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </CategoryIcon>
    ),
    about: (
        <CategoryIcon>
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
        </CategoryIcon>
    ),
}

function SearchIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    )
}

/** Matches across every settings page, each jumping straight to where the setting lives. */
function SettingsSearchResults(props: { query: string }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const results = searchSettings(props.query)

    if (results.length === 0) {
        return (
            <p className="px-4 py-12 text-center text-sm text-[var(--app-hint)]">
                {t('settings.search.empty', { query: props.query.trim() })}
            </p>
        )
    }
    return (
        <ul className="mt-3 overflow-hidden rounded-xl border border-[var(--app-border)]">
            {results.map((entry) => {
                const categoryTitle = t(CATEGORY_TITLE_KEYS[entry.category])
                const title = t(entry.key)
                return (
                    <li key={entry.key} className="border-b border-[var(--app-divider)] last:border-b-0">
                        <button
                            type="button"
                            onClick={() => navigate({ to: entryPath(entry) })}
                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                        >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--app-secondary-bg)] text-[var(--app-link)]">
                                {CATEGORY_ICONS[entry.category]}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-[var(--app-fg)]">{title}</span>
                                {title !== categoryTitle && (
                                    <span className="block truncate text-xs text-[var(--app-hint)]">{categoryTitle}</span>
                                )}
                            </span>
                            <ChevronRightIcon className="shrink-0 text-[var(--app-hint)]" />
                        </button>
                    </li>
                )
            })}
        </ul>
    )
}

/** One-line state of each group, so the list answers "what is set?" without drilling in. */
function useCategorySummaries(): Record<SettingsCategoryId, string> {
    const { t, locale } = useTranslation()
    const { api } = useAppContext()
    const { appearance, chatPageSize } = useSettingsState()
    const credentials = useCredentials(api, true)
    const machines = useManagedMachines(api)
    const apiKeys = useApiKeys(api, true)

    const appearanceKey = getAppearanceOptions().find((option) => option.value === appearance)?.labelKey
        ?? 'settings.display.appearance.system'
    const online = machines.machines.filter((machine) => machine.active).length

    return {
        general: `${locales.find((entry) => entry.value === locale)?.nativeLabel ?? 'English'} · ${t(appearanceKey)}`,
        chat: t('settings.summary.chat', { n: chatPageSize }),
        models: credentials.isLoading ? '' : t('settings.summary.providers', { n: credentials.credentials.length }),
        devices: machines.isLoading ? '' : t('settings.summary.onlineMachines', { n: online }),
        sessions: t('settings.summary.sessions'),
        account: apiKeys.isLoading ? '' : t('settings.summary.apiKeys', {
            n: apiKeys.apiKeys.filter((key) => key.revokedAt === null).length
        }),
        about: t('settings.summary.version', { v: __APP_VERSION__ }),
    }
}

/** The category list: the whole of level 1 on a phone, the left pane on desktop. */
export function SettingsCategoryList(props: { active: SettingsCategoryId | null; sidebar?: boolean }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { logout } = useAppContext()
    const summaries = useCategorySummaries()
    const [query, setQuery] = useState('')

    return (
        <nav aria-label={t('settings.title')} className="px-3 py-2">
            <label className="mt-1 flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 focus-within:border-[var(--app-link)]">
                <span className="text-[var(--app-hint)]"><SearchIcon /></span>
                <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('settings.search.placeholder')}
                    aria-label={t('settings.search.placeholder')}
                    className="min-w-0 flex-1 bg-transparent py-2 text-base text-[var(--app-fg)] placeholder-[var(--app-hint)] outline-none"
                />
            </label>
            {query.trim() ? <SettingsSearchResults query={query} /> : CATEGORY_ORDER.map((group) => (
                <ul key={group.join()} className="mt-3 overflow-hidden rounded-xl border border-[var(--app-border)] first:mt-1">
                    {group.map((id) => {
                        const isActive = id === props.active
                        return (
                            <li key={id} className="border-b border-[var(--app-divider)] last:border-b-0">
                                <button
                                    type="button"
                                    onClick={() => navigate({ to: `/settings/${id}` })}
                                    aria-current={isActive ? 'page' : undefined}
                                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                                        isActive ? 'bg-[var(--app-subtle-bg)]' : 'hover:bg-[var(--app-subtle-bg)]'
                                    }`}
                                >
                                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                                        isActive ? 'bg-[var(--app-link)] text-white' : 'bg-[var(--app-secondary-bg)] text-[var(--app-link)]'
                                    }`}>
                                        {CATEGORY_ICONS[id]}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[var(--app-fg)]">{t(CATEGORY_TITLE_KEYS[id])}</span>
                                        <span className="block min-h-4 truncate text-xs text-[var(--app-hint)]">{summaries[id]}</span>
                                    </span>
                                    {props.sidebar ? null : <ChevronRightIcon className="shrink-0 text-[var(--app-hint)]" />}
                                </button>
                            </li>
                        )
                    })}
                </ul>
            ))}
            <div className="mt-3 pb-[env(safe-area-inset-bottom)]">
                <SettingsLogOutButton label={t('settings.logOut')} onLogOut={logout} />
            </div>
        </nav>
    )
}

function activeCategory(pathname: string): SettingsCategoryId | null {
    const segment = pathname.split('/')[2]
    return segment && segment in CATEGORY_TITLE_KEYS ? segment as SettingsCategoryId : null
}

/**
 * `/settings` layout. Desktop keeps the category list beside the content;
 * a phone drills down one level at a time and the outlet fills the screen.
 */
export default function SettingsLayout() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { settingsNav } = useWorkspaceLayout()
    const pathname = useLocation({ select: (location) => location.pathname })

    return (
        <SettingsStateProvider>
            {settingsNav === 'persistent' ? (
                <div className="flex h-full min-h-0">
                    <aside className="flex w-80 shrink-0 flex-col border-r border-[var(--app-border)]">
                        <SettingsPageHeader title={t('settings.title')} onBack={() => navigate({ to: '/sessions' })} />
                        <div className="min-h-0 flex-1 overflow-y-auto app-scroll-y">
                            <SettingsCategoryList active={activeCategory(pathname) ?? 'general'} sidebar />
                        </div>
                    </aside>
                    <main className="min-w-0 flex-1">
                        <Outlet />
                    </main>
                </div>
            ) : (
                <Outlet />
            )}
        </SettingsStateProvider>
    )
}

/** `/settings` itself: the category list on a phone, General beside the nav on desktop. */
export function SettingsHome() {
    const { t } = useTranslation()
    const { settingsNav } = useWorkspaceLayout()
    if (settingsNav === 'persistent') return <GeneralSettings />
    return (
        <div className="flex h-full min-h-0 flex-col">
            <SettingsPageHeader title={t('settings.title')} />
            <div className="min-h-0 flex-1 overflow-y-auto app-scroll-y">
                <div className="mx-auto w-full max-w-content">
                    <SettingsCategoryList active={null} />
                </div>
            </div>
        </div>
    )
}
