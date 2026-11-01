import { act, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import TerminalPage from './terminal'

const writeMock = vi.fn()
const terminalMock = vi.hoisted(() => ({ focus: vi.fn(), onData: vi.fn(() => ({ dispose: vi.fn() })) }))
const layoutMock = vi.hoisted(() => ({ composer: 'docked' as 'docked' | 'inline' }))
vi.mock('@/hooks/useWorkspaceLayout', () => ({ useWorkspaceLayout: () => layoutMock }))

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'session-1' })
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: null,
        token: 'test-token',
        baseUrl: 'http://localhost:3000'
    })
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => vi.fn()
}))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({
        session: {
            id: 'session-1',
            active: true,
            metadata: { path: '/tmp/project' }
        }
    })
}))

vi.mock('@/hooks/useTerminalSocket', () => ({
    useTerminalSocket: () => ({
        state: { status: 'connected' as const },
        connect: vi.fn(),
        write: writeMock,
        resize: vi.fn(),
        disconnect: vi.fn(),
        onOutput: vi.fn(),
        onSnapshot: vi.fn(),
        onExit: vi.fn()
    })
}))

vi.mock('@/hooks/useLongPress', () => ({
    useLongPress: ({ onClick }: { onClick: () => void }) => ({
        onClick
    })
}))

vi.mock('@/components/Terminal/TerminalView', () => ({
    TerminalView: ({ onMount }: { onMount: (terminal: unknown) => void }) => {
        useEffect(() => onMount(terminalMock), [onMount])
        return <div data-testid="terminal-view" />
    }
}))

function renderWithProviders() {
    return render(
        <I18nProvider>
            <TerminalPage />
        </I18nProvider>
    )
}

describe('TerminalPage paste behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('does not open manual paste dialog when clipboard text is empty', async () => {
        const readText = vi.fn(async () => '')
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText }
        })

        renderWithProviders()
        fireEvent.click(screen.getAllByRole('button', { name: 'Paste' })[0])

        await waitFor(() => {
            expect(readText).toHaveBeenCalledTimes(1)
        })
        expect(writeMock).not.toHaveBeenCalled()
        expect(screen.queryByText('Paste input')).not.toBeInTheDocument()
    })

    it('opens manual paste dialog when clipboard read fails', async () => {
        const readText = vi.fn(async () => {
            throw new Error('blocked')
        })
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText }
        })

        renderWithProviders()
        fireEvent.click(screen.getAllByRole('button', { name: 'Paste' })[0])

        expect(await screen.findByText('Paste input')).toBeInTheDocument()
    })

    it('sends a single Enter from the compact paste/enter row', () => {
        renderWithProviders()
        fireEvent.click(screen.getAllByRole('button', { name: '↵ Enter' })[0])
        expect(writeMock).toHaveBeenCalledExactlyOnceWith('\r')
    })


    it('writes exactly Ctrl+C from its dedicated button', () => {
        renderWithProviders()
        fireEvent.click(screen.getAllByRole('button', { name: 'Interrupt (Ctrl+C)' })[0])
        expect(writeMock).toHaveBeenCalledExactlyOnceWith('\x03')
    })

    it('does not focus the mobile terminal when voice inserts a command', async () => {
        const ready = vi.fn()
        render(<I18nProvider><TerminalPage onVoiceInputReady={ready} /></I18nProvider>)
        await waitFor(() => expect(ready).toHaveBeenCalled())
        const writer = ready.mock.calls.at(-1)?.[0] as (text: string) => boolean
        terminalMock.focus.mockClear()
        act(() => { expect(writer('pwd\r')).toBe(true) })
        expect(writeMock).toHaveBeenCalledExactlyOnceWith('pwd\r')
        expect(terminalMock.focus).not.toHaveBeenCalled()
    })

})
