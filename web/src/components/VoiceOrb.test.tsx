import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceOverlay } from './VoiceOrb'
import { useVoiceAutoSend } from '@/hooks/useVoiceAutoSend'

vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }) }))
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

it('does not add floating buttons while the draft is hidden', () => {
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


it('shows the actual output and forwards a device choice without interrupting readback', () => {
    const select = vi.fn()
    const stop = vi.fn()
    const props = { caption: null, draft: '', drafting: false, sending: false, onClear: vi.fn(), onSend: vi.fn(), readbackActive: true, panelVisibility: 'open' as const,
        onInterruptReadback: stop, onSelectReadbackOutput: select }
    const output = { preference: 'speaker', label: null, status: 'unavailable' as const, devices: [{ deviceId: 'speaker-id', label: 'Speakers' }], canPick: true }
    const { rerender } = render(<VoiceOverlay {...props} readbackOutput={output} />)
    fireEvent.click(screen.getByRole('button', { name: 'composer.settings' }))
    expect(screen.getByRole('combobox', { name: 'readback.output.label' })).toBeInTheDocument()
    expect(screen.getByText('readback.output.unavailable')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'readback.output.label' }), { target: { value: 'choose' } })
    expect(select).toHaveBeenCalledWith('choose')
    expect(stop).not.toHaveBeenCalled()
    rerender(<VoiceOverlay {...props} readbackOutput={{ ...output, preference: 'speaker-id', status: 'selected', label: 'Speakers' }} />)
    expect(screen.queryByText('readback.output.unavailable')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'readback.output.label' })).toHaveValue('speaker-id')
})

it('opens language and sensitivity together from the draft settings icon', () => {
    const language = vi.fn()
    const props = { caption: null, draft: '', drafting: false, sending: false, onClear: vi.fn(), onSend: vi.fn(), readbackActive: true, panelVisibility: 'open' as const,
        readbackLanguage: 'zh' as const, onReadbackLanguageChange: language,
        readbackOutput: { preference: 'speaker', label: null, status: 'system' as const, devices: [], canPick: false } }
    const { rerender } = render(<VoiceOverlay {...props} />)
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'composer.settings' }))
    expect(screen.getByRole('slider')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'readback.output.label' })).toBeInTheDocument()
    rerender(<VoiceOverlay {...props} draft="Edit this draft" />)
    expect(screen.getByRole('combobox', { name: 'readback.output.label' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'readback.language' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'readback.language' }), { target: { value: 'en' } })
    expect(language).toHaveBeenCalledExactlyOnceWith('en')
    fireEvent.click(screen.getByRole('button', { name: 'button.close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('opens microphone sensitivity controls without receiving any speech', () => {
    render(<VoiceOverlay caption={null} draft="" panelVisibility="open" drafting={false} sending={false} onClear={vi.fn()} onSend={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'composer.settings' }))
    expect(screen.getByRole('slider', { name: 'voice.omni.sensitivity.label' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'button.close' }))
    fireEvent.click(screen.getByRole('button', { name: 'voice.ui.closeDraft' }))
    expect(screen.queryByRole('button', { name: 'voice.ui.openDraft' })).not.toBeInTheDocument()
})

it.each(['chat', 'terminal'] as const)('omits Ctrl+C from the %s draft panel', target => {
    render(<VoiceOverlay caption={null} draft="Draft" target={target} drafting={false} sending={false}
        onClear={vi.fn()} onSend={vi.fn()} onKey={vi.fn()} />)
    expect(screen.queryByText('Ctrl+C')).not.toBeInTheDocument()
    if (target === 'terminal') expect(screen.getByRole('button', { name: 'Tab' })).toBeInTheDocument()
})

it('keeps drafts hidden in manual mode until explicitly opened', () => {
    localStorage.setItem('hapi.voicePanelMode', 'manual')
    const props = { caption: null, draft: 'Draft', drafting: false, sending: false, onClear: vi.fn(), onSend: vi.fn() }
    const { rerender } = render(<VoiceOverlay {...props} />)
    expect(screen.queryByText('Draft')).not.toBeInTheDocument()
    rerender(<VoiceOverlay {...props} panelVisibility="open" />)
    expect(screen.getByText('Draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'composer.settings' }))
    expect(screen.getByRole('combobox', { name: 'voice.omni.panel.mode' })).toHaveValue('manual')
})

it('lets the draft panel pause and resume microphone capture', () => {
    const toggle = vi.fn()
    const props = { caption: null, draft: 'Draft', drafting: false, sending: false, onClear: vi.fn(), onSend: vi.fn(), onToggleMic: toggle }
    const { rerender } = render(<VoiceOverlay {...props} micOn />)
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.mic.pause' }))
    expect(toggle).toHaveBeenCalledOnce()
    rerender(<VoiceOverlay {...props} micOn={false} />)
    expect(screen.getByRole('button', { name: 'voice.omni.mic.resume' })).toBeInTheDocument()
    expect(screen.getByText('Draft')).toBeInTheDocument()
})

it('opens an unabridged model-context snapshot and refreshes it on request', () => {
    const context = vi.fn().mockReturnValue('Full model instructions\nCurrent draft\nCorrection ledger')
    render(<VoiceOverlay caption={null} draft="Draft" drafting={false} sending={false} onClear={vi.fn()} onSend={vi.fn()} getDebugContext={context} />)
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.debug.title' }))
    expect(screen.getByRole('textbox', { name: 'voice.omni.debug.context' })).toHaveValue('Full model instructions\nCurrent draft\nCorrection ledger')
    context.mockReturnValue('Updated complete model context')
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.debug.refresh' }))
    expect(screen.getByRole('textbox', { name: 'voice.omni.debug.context' })).toHaveValue('Updated complete model context')
    fireEvent.click(screen.getByRole('button', { name: 'button.close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('persists the draft language independently of readback language', () => {
    const props = { caption: null, draft: 'Draft', drafting: false, sending: false, onSend: vi.fn(), onClear: vi.fn() }
    const first = render(<VoiceOverlay {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'composer.settings' }))
    const language = screen.getByRole('combobox', { name: 'voice.omni.draft.language' })
    expect(language).toHaveValue('original')
    expect(Array.from((language as HTMLSelectElement).options, option => option.value)).toEqual(['original', 'zh', 'en'])
    fireEvent.change(language, { target: { value: 'en' } })
    first.unmount()
    render(<VoiceOverlay {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'composer.settings' }))
    expect(screen.getByRole('combobox', { name: 'voice.omni.draft.language' })).toHaveValue('en')
})

it('shows translation candidates below the draft and lets the user adopt one without sending', () => {
    localStorage.setItem('hapi.voiceDraftLanguage', 'en')
    const change = vi.fn(), send = vi.fn()
    render(<VoiceOverlay caption={null} draft="Main translation" alternatives={['First candidate', 'Second candidate']}
        drafting={false} sending={false} onDraftChange={change} onSend={send} onClear={vi.fn()} />)
    expect(screen.getByText('First candidate')).toBeInTheDocument()
    expect(screen.getByText('Second candidate')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'voice.omni.draft.useAlternative' })[0])
    expect(change).toHaveBeenCalledWith('First candidate')
    expect(send).not.toHaveBeenCalled()
})
