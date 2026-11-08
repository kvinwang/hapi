import { VoiceDraftText } from '@/components/VoiceDraftText'
import { OPEN_VOICE_PANEL, useVoicePanelSettings, type VoicePanelMode } from '@/hooks/useVoicePanelSettings'
import { Close as DialogClose } from '@radix-ui/react-dialog'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { setVoiceSensitivity, useVoiceSensitivity } from '@/lib/voiceSensitivity'
export { VOICE_ENVIRONMENTS, getVoiceEnvironment, setVoiceEnvironment, type VoiceEnvironment } from '@/lib/voiceSensitivity'
import type { ReadbackLanguage } from '@/hooks/useReadbackSettings'
import type { ReadbackOutputState } from '@/lib/readbackOutput'
import type { DeferredSpeech } from '@/lib/voiceDraftIntent'
import { TERMINAL_KEYS, type TerminalKey } from '@/lib/terminalKeys'
import { useVoicePanelPosition } from '@/hooks/useVoicePanelPosition'
import { getVoiceTerminalExecute, setVoiceTerminalExecute } from '@/lib/terminalVoice'
import { useVoiceAutoSendSettings, type VoiceAutoSendDelay } from '@/hooks/useVoiceAutoSend'
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { OmniCaption, VoiceDraftIssue, OmniVoiceState } from '@/hooks/useOmniVoice'
import { useTranslation } from '@/lib/use-translation'

const EDGE_GLOW_KEY = 'hapi.voiceEdgeGlow'
const KNOWN_NOTES = new Set(['idle', 'micPermission', 'notConfigured', 'terminalUnavailable', 'terminalSingleLine'])

export function isVoiceEdgeGlowEnabled(): boolean {
    return localStorage.getItem(EDGE_GLOW_KEY) === '1'
}

export function setVoiceEdgeGlowEnabled(on: boolean): void {
    localStorage.setItem(EDGE_GLOW_KEY, on ? '1' : '0')
}

/** Match the 20 Hz capture frames; avoid redundant style writes and background timers. */
function useLevelVar(ref: MutableRefObject<HTMLElement | null>, level: MutableRefObject<number>, active: boolean) {
    useEffect(() => {
        const el = ref.current
        if (!el || !active) return
        let smooth = 0
        let previous = ''
        let timer: ReturnType<typeof setInterval> | undefined
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
        const tick = () => {
            smooth += (level.current - smooth) * 0.6
            const value = smooth.toFixed(2)
            if (value === previous) return
            previous = value
            el.style.setProperty('--orb-level', value)
        }
        const sync = () => {
            clearInterval(timer)
            if (document.visibilityState === 'hidden' || motion.matches) return
            tick()
            timer = setInterval(tick, 50)
        }
        sync()
        document.addEventListener('visibilitychange', sync)
        motion.addEventListener('change', sync)
        return () => {
            clearInterval(timer)
            document.removeEventListener('visibilitychange', sync)
            motion.removeEventListener('change', sync)
            el.style.setProperty('--orb-level', '0')
        }
    }, [ref, level, active])
}

function MicGlyph() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
    )
}

function MicOffGlyph() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18" />
        </svg>
    )
}

/** The AI voice button: a flowing gradient whose motion follows the conversation state and loudness. */
export function VoiceOrb(props: {
    state: OmniVoiceState
    /** The mic switch, shown on its own: the conversation may still be busy (waiting, speaking) with the mic off. */
    micOn: boolean
    level: MutableRefObject<number>
    onClick: () => void
    size?: number
}) {
    const { t } = useTranslation()
    const ref = useRef<HTMLButtonElement | null>(null)
    const size = props.size ?? 36
    useLevelVar(ref, props.level, props.state === 'hearing' || props.state === 'speaking' || props.state === 'listening')

    return (
        <button
            ref={ref}
            type="button"
            data-state={props.state}
            onClick={props.onClick}
            className="voice-orb touch-none"
            style={{ width: size, height: size }}
            title={t(`voice.omni.state.${props.state}`)}
            aria-label={t('voice.omni.toggle')}
            aria-pressed={props.micOn}
        >
            <span className="voice-orb-halo" />
            <span className="voice-orb-core">{props.state === 'off' || props.state === 'error' ? <MicGlyph /> : null}</span>
            {!props.micOn && props.state !== 'off' && props.state !== 'error' ? (
                <span className="voice-orb-badge"><MicOffGlyph /></span>
            ) : null}
        </button>
    )
}

/** What Omni says and notes, fading out a few seconds after the last line. */
function VoiceCaption(props: { caption: OmniCaption | null }) {
    const { t } = useTranslation()
    const [shown, setShown] = useState<OmniCaption | null>(null)
    useEffect(() => {
        if (!props.caption) return
        setShown(props.caption)
        const timer = setTimeout(() => setShown(null), props.caption.role === 'bot' ? 6000 : 4000)
        return () => clearTimeout(timer)
    }, [props.caption])
    if (!shown) return null
    const text = shown.role === 'system' && KNOWN_NOTES.has(shown.text) ? t(`voice.omni.note.${shown.text}`) : shown.text
    return (
        <div key={shown.id} className="voice-caption pointer-events-none max-w-[min(24rem,92vw)] rounded-2xl bg-[var(--app-bg)]/90 px-4 py-2 text-sm text-[var(--app-fg)] shadow-lg backdrop-blur">
            {text}
        </div>
    )
}

/** Captions and the floating draft panel: what Omni made of the user's words, sent only by the Send button. */
export function VoiceOverlay(props: {
    caption: OmniCaption | null
    answerStatus?: 'answering' | 'forwarded' | null
    panelVisibility?: 'auto' | 'open' | 'closed'
    onClosePanel?: () => void
    readbackLanguage?: ReadbackLanguage
    onReadbackLanguageChange?: (value: ReadbackLanguage) => void
    readbackOutput?: ReadbackOutputState | null
    onSelectReadbackOutput?: (value: string) => void
    readbackActive?: boolean
    onInterruptReadback?: () => void
    micRecovering?: boolean
    draft: string
    onDraftChange?: (text: string) => void
    onDraftEditStart?: () => void
    onDraftEditEnd?: () => void
    micOn?: boolean
    getDebugContext?: () => string
    onToggleMic?: () => void
    target?: 'chat' | 'terminal'
    deferred?: DeferredSpeech[]
    onResolveSpeech?: (index: number, include: boolean) => void
    transcription?: string
    draftIssue?: VoiceDraftIssue | null
    drafting: boolean
    sending: boolean
    autoSendSeconds?: number | null
    onSend: () => void
    onClear: () => void
    onResetHistory?: () => void
    onKey?: (key: TerminalKey) => void
}) {
    const { t } = useTranslation()
    const [debugText, setDebugText] = useState('')
    const autoSend = useVoiceAutoSendSettings()
    const sensitivity = useVoiceSensitivity()
    const { mode: panelMode, setMode: setPanelMode } = useVoicePanelSettings()
    const [execute, setExecute] = useState(getVoiceTerminalExecute)
    const showDraft = props.panelVisibility === 'open' || panelMode === 'auto' && props.panelVisibility !== 'closed' && (Boolean(props.deferred?.length) || props.draft !== '' || props.drafting || Boolean(props.draftIssue) || Boolean(props.transcription))
    const panel = useVoicePanelPosition(showDraft)
    const recoveryStatus = props.micRecovering ? <div role="status" className="rounded-xl bg-[var(--app-bg)]/95 px-3 py-2 text-sm text-[var(--app-hint)]">{t('voice.omni.state.recovering')}</div> : null
    const readbackControls = props.readbackActive ? (
        <div className="pointer-events-auto flex max-w-[92vw] flex-wrap items-center gap-3 rounded-xl bg-[var(--app-bg)]/95 px-3 py-2 text-sm shadow-lg">
            <span role="status" className="text-[var(--app-hint)]">{t('readback.active')}</span>
            <button type="button" onClick={props.onInterruptReadback} className="shrink-0 rounded-md border border-[var(--app-border)] px-3 py-1.5 text-[var(--app-fg)]">{t('readback.interrupt')}</button>
        </div>
    ) : null
    return (
        <div className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
            <VoiceCaption caption={props.caption} />
            {props.answerStatus ? <div role="status" className="rounded-lg bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-hint)]">{t(`readback.${props.answerStatus}`)}</div> : null}
            {!showDraft ? <>
                {recoveryStatus}{readbackControls}
            </> : null}
            {showDraft ? (
                <div ref={panel.ref} style={panel.style} className="voice-caption pointer-events-auto w-[min(36rem,92vw)] rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)]/95 p-3 text-[var(--app-fg)] shadow-xl backdrop-blur">
                    <button type="button" aria-label={t('voice.omni.draft.move')} title={t('voice.omni.draft.move')}
                        onContextMenu={(event) => event.preventDefault()} onPointerDown={panel.onPointerDown} className="mb-1 flex h-5 w-full drag-handle cursor-grab items-center justify-center active:cursor-grabbing">
                        <span className="h-1 w-10 rounded-full bg-[var(--app-hint)]/40" />
                    </button>
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-[var(--app-hint)]">
                        <span>{t(props.target === 'terminal' ? 'voice.omni.draft.terminalTitle' : 'voice.omni.draft.title')}</span>
                        {props.drafting ? <span className="animate-pulse">{t('voice.omni.draft.drafting')}</span> : null}
                        {props.onToggleMic ? <button type="button" onClick={props.onToggleMic}
                            aria-pressed={!props.micOn} className="rounded-md border border-[var(--app-border)] px-2 py-1">
                            {t(props.micOn ? 'voice.omni.mic.pause' : 'voice.omni.mic.resume')}
                        </button> : null}
                        {props.getDebugContext ? <Dialog onOpenChange={open => { if (open) setDebugText(props.getDebugContext?.() ?? '') }}>
                            <DialogTrigger asChild>
                                <button type="button" className="rounded-md px-2 py-1 hover:bg-[var(--app-secondary-bg)]">{t('voice.omni.debug.title')}</button>
                            </DialogTrigger>
                            <DialogContent className="pointer-events-auto max-w-3xl space-y-3">
                                <DialogHeader>
                                    <DialogTitle>{t('voice.omni.debug.title')}</DialogTitle>
                                    <DialogDescription>{t('voice.omni.debug.description')}</DialogDescription>
                                </DialogHeader>
                                <textarea readOnly aria-label={t('voice.omni.debug.context')} value={debugText} rows={16}
                                    className="max-h-[60dvh] w-full resize-y select-text rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 font-mono text-xs text-[var(--app-fg)]" />
                                <div className="flex justify-end gap-3 text-sm">
                                    <button type="button" onClick={() => setDebugText(props.getDebugContext?.() ?? '')}>{t('voice.omni.debug.refresh')}</button>
                                    <DialogClose asChild><button type="button">{t('button.close')}</button></DialogClose>
                                </div>
                            </DialogContent>
                        </Dialog> : null}
                        <Dialog>
                            <DialogTrigger asChild>
                                <button type="button" aria-label={t('composer.settings')} title={t('composer.settings')}
                                    className="ml-auto flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--app-secondary-bg)]">
                                    <span aria-hidden="true" className="text-base">⚙</span>
                                </button>
                            </DialogTrigger>
                            <DialogContent className="pointer-events-auto max-w-xs space-y-4" aria-describedby={undefined}>
                                <DialogHeader><DialogTitle>{t('composer.settings')}</DialogTitle></DialogHeader>
                                <label className="block w-64 max-w-full text-xs text-[var(--app-hint)]">
                                    <span className="flex justify-between">
                                        <span>{t('voice.omni.sensitivity.label')}</span>
                                        <span>{sensitivity}%</span>
                                    </span>
                                    <input type="range" min={0} max={100} step={1} value={sensitivity}
                                        aria-label={t('voice.omni.sensitivity.label')}
                                        onChange={(event) => setVoiceSensitivity(Number(event.target.value))}
                                        className="mt-2 w-full" />
                                    <span>{t('voice.omni.sensitivity.hint')}</span>
                                </label>
                                <div className="space-y-3">
                                    {props.onReadbackLanguageChange ? <label className="flex items-center gap-2 text-xs">
                                        {t('readback.language')}
                                        <select aria-label={t('readback.language')} value={props.readbackLanguage ?? 'zh'} onChange={event => props.onReadbackLanguageChange?.(event.target.value as ReadbackLanguage)}
                                            className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1">
                                            <option value="zh">{t('readback.language.zh')}</option>
                                            <option value="en">{t('readback.language.en')}</option>
                                        </select>
                                    </label> : null}
                                    {props.readbackOutput ? <label className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                                        {t('readback.output.label')}
                                        <select aria-label={t('readback.output.label')} value={props.readbackOutput.preference}
                                            onChange={event => props.onSelectReadbackOutput?.(event.target.value)}
                                            className="max-w-48 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1">
                                            <option value="speaker">{t('readback.output.speaker')}</option>
                                            <option value="system">{t('readback.output.system')}</option>
                                            {props.readbackOutput.devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
                                            {!['speaker', 'system'].includes(props.readbackOutput.preference) && !props.readbackOutput.devices.some(device => device.deviceId === props.readbackOutput?.preference)
                                                ? <option value={props.readbackOutput.preference}>{t('readback.output.missing')}</option> : null}
                                            {props.readbackOutput.canPick ? <option value="choose">{t('readback.output.choose')}</option> : null}
                                        </select>
                                        <span>{props.readbackOutput.status === 'selected' ? props.readbackOutput.label : t(`readback.output.${props.readbackOutput.status}`)}</span>
                                    </label> : null}
                                </div>
                                <label className="flex items-center gap-2 text-xs">
                                    {t('voice.omni.panel.mode')}
                                    <select aria-label={t('voice.omni.panel.mode')} value={panelMode}
                                        onChange={event => {
                                            if (event.target.value === 'manual') window.dispatchEvent(new Event(OPEN_VOICE_PANEL))
                                            setPanelMode(event.target.value as VoicePanelMode)
                                        }}
                                        className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1">
                                        <option value="auto">{t('voice.omni.panel.auto')}</option>
                                        <option value="manual">{t('voice.omni.panel.manual')}</option>
                                    </select>
                                </label>
                                <DialogClose asChild><button type="button" className="rounded-md border border-[var(--app-border)] px-3 py-1.5 text-xs">{t('button.close')}</button></DialogClose>
                            </DialogContent>
                        </Dialog>
                        <button type="button" onClick={props.onClosePanel}>{t('voice.ui.closeDraft')}</button>

                    </div>
                    {recoveryStatus}
                    {props.draftIssue ? (
                        <div role="status" className="mb-2 whitespace-pre-wrap break-words text-sm text-[var(--app-hint)]">
                            {t(`voice.omni.draft.issue.${props.draftIssue.reason}`)}
                            {props.draftIssue.detail ? <div>{props.draftIssue.detail}</div> : null}
                        </div>
                    ) : null}
                    <VoiceDraftText value={props.draft} onChange={props.onDraftChange}
                        onEditStart={props.onDraftEditStart} onEditEnd={props.onDraftEditEnd} disabled={props.sending} />
                    {props.transcription ? (
                        <div className="mt-2 border-t border-[var(--app-border)] pt-2 text-xs text-[var(--app-hint)]" role="status">
                            <span>{t('voice.omni.draft.transcription')}</span>
                            <div className="max-h-24 overflow-y-auto whitespace-pre-wrap">{props.transcription}</div>
                        </div>
                    ) : null}
                    {props.deferred?.length ? <div className="mt-2 max-h-40 overflow-y-auto border-t border-[var(--app-border)] pt-2 text-sm">
                        {props.deferred.map((entry, index) => <div key={`${index}:${entry.text}`} className="mb-2" role="status">
                            <div className="text-xs text-[var(--app-hint)]">{t(`voice.omni.draft.${entry.status}`)}</div>
                            <div className="whitespace-pre-wrap break-words">{entry.text}</div>
                            {entry.reason ? <div className="text-xs text-[var(--app-hint)]">{entry.reason}</div> : null}
                            <div className="mt-1 flex gap-3">
                                <button type="button" disabled={props.drafting || props.sending} onClick={() => props.onResolveSpeech?.(index, true)} className="text-xs text-[var(--app-link)] disabled:opacity-40">{t(entry.status === 'unprocessed' ? 'voice.omni.draft.retrySpeech' : 'voice.omni.draft.includeSpeech')}</button>
                                <button type="button" disabled={props.drafting || props.sending} onClick={() => props.onResolveSpeech?.(index, false)} className="text-xs text-[var(--app-hint)] disabled:opacity-40">{t('voice.omni.draft.dismissSpeech')}</button>
                            </div>
                        </div>)}
                    </div> : null}

                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--app-border)] pt-2 text-xs text-[var(--app-hint)]">
                        <label className="flex items-center gap-2">
                            <input type="checkbox" checked={autoSend.enabled}
                                onChange={(event) => autoSend.update({ enabled: event.target.checked, delay: autoSend.delay })} />
                            {t('voice.omni.autoSend.label')}
                        </label>
                        <label className="flex items-center gap-2">
                            {t('voice.omni.autoSend.pause')}
                            <select aria-label={t('voice.omni.autoSend.pause')} value={autoSend.delay}
                                onChange={(event) => autoSend.update({ enabled: autoSend.enabled, delay: Number(event.target.value) as VoiceAutoSendDelay })}
                                className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[var(--app-fg)]">
                                {[...new Set([2, 3, 5, 8, autoSend.delay])].sort((a, b) => a - b).map((seconds) => <option key={seconds} value={seconds}>{t('voice.omni.autoSend.seconds', { n: seconds })}</option>)}
                            </select>
                        </label>
                        {props.target === 'terminal' ? <label className="flex items-center gap-2">
                            <input type="checkbox" checked={execute} onChange={(event) => { setExecute(event.target.checked); setVoiceTerminalExecute(event.target.checked) }} />
                            {t('voice.omni.draft.execute')}
                        </label> : null}
                        <span>{t('voice.omni.autoSend.remember')}</span>
                        {props.autoSendSeconds != null ? <span role="timer" className="text-[var(--app-fg)]">{t(props.autoSendSeconds > 0 ? 'voice.omni.autoSend.countdown' : 'voice.omni.autoSend.waiting', { n: props.autoSendSeconds })}</span> : null}
                    </div>
                    {props.onKey && props.target === 'terminal' ? <div className="mt-2 flex flex-wrap gap-1" aria-label={t('terminal.specialKeys')}>
                        {(Object.keys(TERMINAL_KEYS) as TerminalKey[]).filter(key => key !== 'interrupt').map((key) => (
                            <button key={key} type="button" onClick={() => props.onKey?.(key)}
                                aria-label={TERMINAL_KEYS[key].label}
                                title={TERMINAL_KEYS[key].phrases[0]}
                                className="rounded border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]">
                                {TERMINAL_KEYS[key].label}
                            </button>
                        ))}
                    </div> : null}
                    {readbackControls}
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                        <button type="button" onClick={props.onResetHistory ?? props.onClear} disabled={props.sending} className="rounded-full px-3 py-1.5 text-sm text-[var(--app-hint)] disabled:opacity-40">
                            {t(props.onResetHistory ? 'voice.ui.resetHistory' : 'voice.omni.draft.clear')}
                        </button>
                        <button type="button" onClick={props.onSend} disabled={!props.draft || props.sending} className="rounded-full bg-[var(--app-button)] px-4 py-1.5 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-40">
                            {t(props.target === 'terminal' ? (execute ? 'voice.omni.draft.runTerminal' : 'voice.omni.draft.sendTerminal') : 'voice.omni.draft.send')}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

/** Optional gradient light along the screen edges while a conversation runs. */
export function VoiceEdgeGlow(props: { state: OmniVoiceState; micOn: boolean; level: MutableRefObject<number> }) {
    const ref = useRef<HTMLDivElement | null>(null)
    // It signals "listening": off with the mic, even while the conversation still waits or speaks.
    const on = props.micOn && props.state !== 'error'
    useLevelVar(ref, props.level, on)
    if (!on) return null
    return <div ref={ref} data-state={props.state} className="voice-edge" aria-hidden="true" />
}
