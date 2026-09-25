import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppContextProvider } from '@/lib/app-context'
import type { ApiClient } from '@/api/client'
import { I18nContext, I18nProvider } from '@/lib/i18n-context'
import { en } from '@/lib/locales'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import { SettingsHome } from './index'
import { SettingsStateProvider } from './state'
import AboutSettings from './sections/About'
import GeneralSettings from './sections/General'
import SessionsSettings from './sections/Sessions'

vi.mock('@hapi/protocol', () => ({
    PROTOCOL_VERSION: 1,
}))

// Mock the router hooks
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
    useRouter: () => ({ history: { back: vi.fn() } }),
    useLocation: (options?: { select?: (location: { pathname: string }) => unknown }) => (
        options?.select ? options.select({ pathname: '/settings' }) : { pathname: '/settings' }
    ),
}))

// Mock useFontScale hook
vi.mock('@/hooks/useFontScale', () => ({
    useFontScale: () => ({ fontScale: 1, setFontScale: vi.fn() }),
    getFontScaleOptions: () => [
        { value: 0.875, label: '87.5%' },
        { value: 1, label: '100%' },
        { value: 1.125, label: '112.5%' },
    ],
}))

vi.mock('@/hooks/useTerminalFontSize', () => ({
    useTerminalFontSize: () => ({ terminalFontSize: 13, setTerminalFontSize: vi.fn() }),
    getTerminalFontSizeOptions: () => [
        { value: 9, label: '9px' },
        { value: 13, label: '13px' },
        { value: 17, label: '17px' },
    ],
}))

// Mock useTheme hook
vi.mock('@/hooks/useTheme', () => ({
    useAppearance: () => ({ appearance: 'system', setAppearance: vi.fn() }),
    getAppearanceOptions: () => [
        { value: 'system', labelKey: 'settings.display.appearance.system' },
        { value: 'dark', labelKey: 'settings.display.appearance.dark' },
        { value: 'light', labelKey: 'settings.display.appearance.light' },
    ],
}))

// Mock languages
vi.mock('@/lib/languages', () => ({
    getElevenLabsSupportedLanguages: () => [
        { code: null, name: 'Auto-detect' },
        { code: 'en', name: 'English' },
    ],
    getLanguageDisplayName: (lang: { code: string | null; name: string }) => lang.name,
}))

function withAppContext(ui: React.ReactElement, apiOverrides: Record<string, unknown> = {}) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    return (
        <QueryClientProvider client={queryClient}>
            <AppContextProvider value={{
                api: {
                    getPreferences: vi.fn(async () => ({ systemPrompt: '' })),
                    getCredentials: vi.fn(async () => ({ credentials: [{ id: 'c1' }, { id: 'c2' }] })),
                    getManagedMachines: vi.fn(async () => ({ machines: [{ id: 'm1', active: true }, { id: 'm2', active: false }] })),
                    getApiKeys: vi.fn(async () => ({ apiKeys: [] })),
                    ...apiOverrides
                } as unknown as ApiClient,
                token: 'test-token',
                baseUrl: 'http://localhost',
                logout: vi.fn(),
            }}>
                <SettingsStateProvider>{ui}</SettingsStateProvider>
            </AppContextProvider>
        </QueryClientProvider>
    )
}

function renderWithProviders(ui: React.ReactElement, apiOverrides?: Record<string, unknown>) {
    return render(
        <I18nProvider>
            {withAppContext(ui, apiOverrides)}
        </I18nProvider>
    )
}

function renderWithSpyT(ui: React.ReactElement) {
    const translations = en as Record<string, string>
    const spyT = vi.fn((key: string) => translations[key] ?? key)
    render(
        <I18nContext.Provider value={{ t: spyT, locale: 'en', setLocale: vi.fn() }}>
            {withAppContext(ui)}
        </I18nContext.Provider>
    )
    return spyT
}

describe('Settings', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        // Mock localStorage
        const localStorageMock = {
            getItem: vi.fn(() => 'en'),
            setItem: vi.fn(),
            removeItem: vi.fn(),
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock })
    })

    it('lists every category with a one-line summary, and log out', async () => {
        renderWithProviders(<SettingsHome />)
        for (const title of ['General', 'Chat', 'Models & Agents', 'Devices', 'Sessions', 'Account', 'About']) {
            expect(screen.getByRole('button', { name: new RegExp(`^${title}`) })).toBeInTheDocument()
        }
        expect(screen.getByText('English · Follow System')).toBeInTheDocument()
        expect(await screen.findByText('Providers: 2')).toBeInTheDocument()
        expect(await screen.findByText('Machines online: 1')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Log Out' })).toBeInTheDocument()
    })

    it('displays the App Version with correct value', () => {
        renderWithProviders(<AboutSettings />)
        expect(screen.getAllByText('App Version').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText(__APP_VERSION__).length).toBeGreaterThanOrEqual(1)
    })

    it('displays the Protocol Version with correct value', () => {
        renderWithProviders(<AboutSettings />)
        expect(screen.getAllByText('Protocol Version').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText(String(PROTOCOL_VERSION)).length).toBeGreaterThanOrEqual(1)
    })

    it('displays the website link with correct URL and security attributes', () => {
        renderWithProviders(<AboutSettings />)
        expect(screen.getAllByText('Website').length).toBeGreaterThanOrEqual(1)
        const links = screen.getAllByRole('link', { name: 'hapi.run' })
        expect(links.length).toBeGreaterThanOrEqual(1)
        const link = links[0]
        expect(link).toHaveAttribute('href', 'https://hapi.run')
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('uses correct i18n keys for About section', () => {
        const spyT = renderWithSpyT(<AboutSettings />)
        const calledKeys = spyT.mock.calls.map((call) => call[0])
        expect(calledKeys).toContain('settings.about.title')
        expect(calledKeys).toContain('settings.about.website')
        expect(calledKeys).toContain('settings.about.appVersion')
        expect(calledKeys).toContain('settings.about.protocolVersion')
    })

    it('renders the Appearance setting', () => {
        renderWithProviders(<GeneralSettings />)
        expect(screen.getAllByText('Appearance').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Follow System').length).toBeGreaterThanOrEqual(1)
    })

    it('uses correct i18n keys for Appearance setting', () => {
        const spyT = renderWithSpyT(<GeneralSettings />)
        const calledKeys = spyT.mock.calls.map((call) => call[0])
        expect(calledKeys).toContain('settings.display.appearance')
        expect(calledKeys).toContain('settings.display.appearance.system')
    })

    it('renders the Terminal Font Size setting', () => {
        renderWithProviders(<GeneralSettings />)
        expect(screen.getAllByText('Terminal Font Size').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('13px').length).toBeGreaterThanOrEqual(1)
    })

    it('closes sessions idle for 10+ days one by one, children first', async () => {
        // Earlier tests leave their pages mounted; start from a clean DOM.
        cleanup()
        const old = Date.now() - 11 * 24 * 60 * 60 * 1000
        const session = (id: string, extra: Record<string, unknown> = {}) => ({
            id, active: true, updatedAt: old, parentSessionId: null, ...extra
        })
        const getSessions = vi.fn(async () => ({
            sessions: [
                session('parent'),
                session('child', { parentSessionId: 'parent' }),
                session('fresh', { updatedAt: Date.now() }),
                session('closed', { active: false })
            ]
        }))
        const archiveSession = vi.fn(async () => {})
        renderWithProviders(<SessionsSettings />, { getSessions, archiveSession })

        fireEvent.click(screen.getByRole('button', { name: 'Close sessions idle for 10+ days' }))
        const confirm = await screen.findByRole('button', { name: 'Close' })
        expect(screen.getByText(/Close 2 sessions idle/)).toBeInTheDocument()
        fireEvent.click(confirm)

        await waitFor(() => expect(screen.getByText('Closed 2 sessions.')).toBeInTheDocument())
        expect(archiveSession.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['child', 'parent'])
    })
})
