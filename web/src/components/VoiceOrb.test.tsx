import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceOverlay } from './VoiceOrb'
import { useVoiceAutoSend } from '@/hooks/useVoiceAutoSend'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers() })

describe('voice draft feedback', () => {
    it('keeps an empty failed draft panel visible with a reason and a dismiss action', () => {
        const clear = vi.fn()
        render(<VoiceOverlay caption={null} draft="" drafting={false} sending={false}
            draftIssue={{ reason: 'service', detail: 'Audio transcription unavailable' }} onClear={clear} onSend={vi.fn()} />)
        expect(screen.getByRole('status')).toHaveTextContent('Audio transcription unavailable')
        expect(screen.getByRole('button', { name: 'voice.omni.draft.send' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.clear' }))
        expect(clear).toHaveBeenCalledOnce()
    })
})


it.each(['5', '8'])('remembers auto-send and the %s second pause in the draft panel', (delay) => {
    const props = { caption: null, draft: 'Draft', drafting: false, sending: false, onSend: vi.fn(), onClear: vi.fn() }
    const first = render(<VoiceOverlay {...props} />)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: delay } })
    first.unmount()
    render(<VoiceOverlay {...props} />)
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('combobox')).toHaveValue(delay)
    expect(screen.getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual(['2', '3', '5', '8'])
})


it('shows sidelined speech without a draft and offers include and dismiss actions', () => {
    const resolve = vi.fn()
    render(<VoiceOverlay caption={null} draft="" drafting={false} sending={false} onClear={vi.fn()} onSend={vi.fn()}
        deferred={[{ text: 'Not talking to you', reason: 'Recipient unclear', status: 'unprocessed' }]} onResolveSpeech={resolve} />)
    expect(screen.getByRole('status')).toHaveTextContent('Not talking to you')
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.retrySpeech' }))
    expect(resolve).toHaveBeenLastCalledWith(0, true)
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.dismissSpeech' }))
    expect(resolve).toHaveBeenLastCalledWith(0, false)
})


it('shows a playback interrupt button even with voice input off and no draft', () => {
    const stop = vi.fn()
    render(<VoiceOverlay caption={null} draft="" drafting={false} sending={false} onClear={vi.fn()} onSend={vi.fn()}
        readbackActive onInterruptReadback={stop} />)
    expect(screen.getByRole('status')).toHaveTextContent('readback.active')
    fireEvent.click(screen.getByRole('button', { name: 'readback.interrupt' }))
    expect(stop).toHaveBeenCalledOnce()
})

it('hides the draft without a persistent reopen button and reveals it automatically', () => {
    const clear = vi.fn()
    const props = { caption: null, draft: 'Retained draft', drafting: false, sending: false, onClear: clear, onSend: vi.fn() }
    const { rerender } = render(<VoiceOverlay {...props} panelVisibility="closed" />)
    expect(screen.queryByText('Retained draft')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'voice.ui.openDraft' })).not.toBeInTheDocument()
    expect(clear).not.toHaveBeenCalled()
    rerender(<VoiceOverlay {...props} panelVisibility="auto" />)
    expect(screen.getByText('Retained draft')).toBeInTheDocument()
})


it.each(['5', '8'])('applies the panel selection to the active %s second countdown', async (delay) => {
    vi.useFakeTimers()
    const send = vi.fn(async () => {})
    const pause = Date.now()
    function Panel() {
        const remaining = useVoiceAutoSend({ silenceSince: pause, ready: true, draft: 'Draft', send })
        return <VoiceOverlay caption={null} draft="Draft" drafting={false} sending={false}
            autoSendSeconds={remaining} onSend={send} onClear={vi.fn()} />
    }
    render(<Panel />)
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: delay } })
    await act(async () => vi.advanceTimersByTimeAsync(Number(delay) * 1000 - 1))
    expect(send).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(send).toHaveBeenCalledOnce()
})
