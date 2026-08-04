import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SwitchAgentDialog } from './SwitchAgentDialog'

function renderDialog(overrides: Partial<React.ComponentProps<typeof SwitchAgentDialog>> = {}) {
    const onSwitch = vi.fn().mockResolvedValue({ sessionId: 's1', resumedTranscript: false })
    const onClose = vi.fn()
    render(
        <I18nProvider>
            <SwitchAgentDialog
                isOpen
                onClose={onClose}
                currentAgent="claude"
                hasDrivenBefore={() => false}
                onSwitch={onSwitch}
                isPending={false}
                {...overrides}
            />
        </I18nProvider>
    )
    return { onSwitch, onClose }
}

function confirmButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: 'Switch' }) as HTMLButtonElement
}

beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
        value: { getItem: vi.fn(() => 'en'), setItem: vi.fn(), removeItem: vi.fn() },
        configurable: true
    })
})

// vitest runs with `globals: false`, so testing-library never registers its own auto-cleanup and
// dialogs from earlier tests would otherwise still be in the DOM.
afterEach(cleanup)

describe('SwitchAgentDialog', () => {
    it('defaults to an agent other than the one already driving', () => {
        renderDialog({ currentAgent: 'claude' })

        expect((screen.getByRole('radio', { name: /codex/i }) as HTMLInputElement).checked).toBe(true)
    })

    it('sends the target agent along with both options', async () => {
        const { onSwitch } = renderDialog()

        fireEvent.click(screen.getByRole('radio', { name: /grok/i }))
        fireEvent.click(confirmButton())

        await waitFor(() => expect(onSwitch).toHaveBeenCalledWith({
            targetAgent: 'grok',
            resetContext: false,
            injectCatchUpPrompt: true
        }))
    })

    it('defaults to sending the catch-up prompt and keeping the context', () => {
        renderDialog()

        expect((screen.getByRole('checkbox', { name: /Send a catch-up prompt/ }) as HTMLInputElement).checked).toBe(true)
        expect((screen.getByRole('checkbox', { name: /Reset context/ }) as HTMLInputElement).checked).toBe(false)
    })

    it('blocks re-selecting the current agent unless the point is to reset it', () => {
        renderDialog({ currentAgent: 'claude' })

        fireEvent.click(screen.getByRole('radio', { name: /claude/i }))
        expect(confirmButton().disabled).toBe(true)

        fireEvent.click(screen.getByRole('checkbox', { name: /Reset context/ }))
        expect(confirmButton().disabled).toBe(false)
    })

    it('explains that a returning agent would otherwise resume its own transcript', () => {
        renderDialog({ currentAgent: 'claude', hasDrivenBefore: (agent) => agent === 'codex' })

        expect(screen.getByText(/codex has driven this session before/)).toBeTruthy()
    })

    it('says a first-time agent starts fresh either way', () => {
        renderDialog({ currentAgent: 'claude', hasDrivenBefore: () => false })

        expect(screen.getByText(/codex has never driven this session/)).toBeTruthy()
    })

    it('closes once the switch goes through', async () => {
        const { onClose } = renderDialog()

        fireEvent.click(confirmButton())

        await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it('stays open and surfaces the reason when the switch fails', async () => {
        const onSwitch = vi.fn().mockRejectedValue(new Error('No machine online'))
        const onClose = vi.fn()
        render(
            <I18nProvider>
                <SwitchAgentDialog
                    isOpen
                    onClose={onClose}
                    currentAgent="claude"
                    hasDrivenBefore={() => false}
                    onSwitch={onSwitch}
                    isPending={false}
                />
            </I18nProvider>
        )

        fireEvent.click(confirmButton())

        await waitFor(() => expect(screen.getByText('No machine online')).toBeTruthy())
        expect(onClose).not.toHaveBeenCalled()
    })
})
