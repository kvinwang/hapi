import { en, zhCN } from '@/lib/locales'

export type SettingsCategoryId = 'general' | 'chat' | 'models' | 'devices' | 'sessions' | 'account' | 'about'

export const CATEGORY_TITLE_KEYS: Record<SettingsCategoryId, string> = {
    general: 'settings.group.general',
    chat: 'settings.section.chat',
    models: 'settings.group.models',
    devices: 'settings.section.devices',
    sessions: 'settings.section.sessions',
    account: 'settings.group.account',
    about: 'settings.about.title',
}

export const CATEGORY_ORDER: SettingsCategoryId[][] = [
    ['general', 'chat'],
    ['models', 'devices', 'sessions'],
    ['account', 'about'],
]

export type SettingsEntry = { key: string; category: SettingsCategoryId; path?: string }

/** Every searchable setting and the page it lives on (the category page unless `path` says otherwise). */
const SETTINGS_ENTRIES: SettingsEntry[] = [
    { key: 'settings.language.label', category: 'general' },
    { key: 'settings.display.appearance', category: 'general' },
    { key: 'settings.display.fontSize', category: 'general' },
    { key: 'settings.display.terminalFontSize', category: 'general' },
    { key: 'settings.display.liteUi', category: 'general' },
    { key: 'settings.chat.pageSize', category: 'chat' },
    { key: 'settings.chat.staleCacheIdle', category: 'chat' },
    { key: 'settings.display.rainbowText', category: 'chat' },
    { key: 'settings.voice.language', category: 'chat' },
    { key: 'settings.nav.providers', category: 'models', path: 'models/providers' },
    { key: 'settings.systemPrompt.title', category: 'models' },
    { key: 'settings.modelPricing.title', category: 'models' },
    { key: 'settings.nav.machines', category: 'devices', path: 'devices/machines' },
    { key: 'settings.section.addDevice', category: 'devices', path: 'devices/add' },
    { key: 'settings.nav.speakers', category: 'devices', path: 'devices/speakers' },
    { key: 'settings.sessions.pruneEmpty', category: 'sessions' },
    { key: 'settings.sessions.closeStale', category: 'sessions' },
    { key: 'settings.nav.apiKeys', category: 'account', path: 'account/keys' },
    { key: 'settings.logOut', category: 'account' },
    { key: 'settings.about.website', category: 'about' },
    { key: 'settings.about.appVersion', category: 'about' },
    { key: 'settings.about.protocolVersion', category: 'about' },
    { key: 'settings.display.performanceMonitor', category: 'about' },
]

const CATEGORY_ENTRIES: SettingsEntry[] = CATEGORY_ORDER.flat()
    .map((category) => ({ key: CATEGORY_TITLE_KEYS[category], category }))

const dictionaries: ReadonlyArray<Record<string, string>> = [en, zhCN]

/** Settings whose label matches in either language, so "外观" works while the UI is in English. */
export function searchSettings(query: string): SettingsEntry[] {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return [...CATEGORY_ENTRIES, ...SETTINGS_ENTRIES].filter((entry) =>
        dictionaries.some((dictionary) => (dictionary[entry.key] ?? '').toLowerCase().includes(needle)))
}

export function entryPath(entry: SettingsEntry): string {
    return `/settings/${entry.path ?? entry.category}`
}
