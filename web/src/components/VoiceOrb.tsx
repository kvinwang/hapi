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

const ENVIRONMENT_KEY = 'hapi.voiceEnvironment'

/** How hard it is to count as speech: a noisy place (restaurant) needs a higher bar so bystanders are not drafted. */
export const VOICE_ENVIRONMENTS = { normal: 0.5, noisy: 0.75, 'very-noisy': 0.9 } as const
export type VoiceEnvironment = keyof typeof VOICE_ENVIRONMENTS

export function getVoiceEnvironment(): VoiceEnvironment {
    const stored = localStorage.getItem(ENVIRONMENT_KEY)
    return stored && stored in VOICE_ENVIRONMENTS ? stored as VoiceEnvironment : 'normal'
}

export function setVoiceEnvironment(value: VoiceEnvironment): void {
    localStorage.setItem(ENVIRONMENT_KEY, value)
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
        <div key={shown.id} className="voice-caption pointer-events-none max-w-[min(36rem,92vw)] rounded-2xl bg-[var(--app-bg)]/90 px-4 py-2 text-sm text-[var(--app-fg)] shadow-lg backdrop-blur">
            {text}
        </div>
    )
}

/** Captions and the floating draft panel: what Omni made of the user's words, sent only by the Send button. */
export function VoiceOverlay(props: {
    caption: OmniCaption | null
    draft: string
    target?: 'chat' | 'terminal'
    transcription?: string
    draftIssue?: VoiceDraftIssue | null
    drafting: boolean
    sending: boolean
    onSend: () => void
    onClear: () => void
    onKey?: (key: TerminalKey) => void
}) {
    const { t } = useTranslation()
    const autoSend = useVoiceAutoSendSettings()
    const [execute, setExecute] = useState(getVoiceTerminalExecute)
    const showDraft = props.draft !== '' || props.drafting || Boolean(props.draftIssue) || Boolean(props.transcription)
    const panel = useVoicePanelPosition(showDraft)
    return (
        <div className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
            <VoiceCaption caption={props.caption} />
            {showDraft ? (
                <div ref={panel.ref} style={panel.style} className="voice-caption pointer-events-auto w-[min(36rem,92vw)] rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)]/95 p-3 text-[var(--app-fg)] shadow-xl backdrop-blur">
                    <button type="button" aria-label={t('voice.omni.draft.move')} title={t('voice.omni.draft.move')}
                        onContextMenu={(event) => event.preventDefault()} onPointerDown={panel.onPointerDown} className="mb-1 flex h-5 w-full drag-handle cursor-grab items-center justify-center active:cursor-grabbing">
                        <span className="h-1 w-10 rounded-full bg-[var(--app-hint)]/40" />
                    </button>
                    <div className="mb-1 flex items-center gap-2 text-xs text-[var(--app-hint)]">
                        <span>{t(props.target === 'terminal' ? 'voice.omni.draft.terminalTitle' : 'voice.omni.draft.title')}</span>
                        {props.drafting ? <span className="animate-pulse">{t('voice.omni.draft.drafting')}</span> : null}
                    </div>
                    {props.draftIssue ? (
                        <div role="status" className="mb-2 whitespace-pre-wrap break-words text-sm text-[var(--app-hint)]">
                            {t(`voice.omni.draft.issue.${props.draftIssue.reason}`)}
                            {props.draftIssue.detail ? <div>{props.draftIssue.detail}</div> : null}
                        </div>
                    ) : null}
                    <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm">{props.draft}</div>
                    {props.transcription ? (
                        <div className="mt-2 border-t border-[var(--app-border)] pt-2 text-xs text-[var(--app-hint)]" role="status">
                            <span>{t('voice.omni.draft.transcription')}</span>
                            <div className="max-h-24 overflow-y-auto whitespace-pre-wrap">{props.transcription}</div>
                        </div>
                    ) : null}
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
                                {[2, 3, 5].map((seconds) => <option key={seconds} value={seconds}>{t('voice.omni.autoSend.seconds', { n: seconds })}</option>)}
                            </select>
                        </label>
                        {props.target === 'terminal' ? <label className="flex items-center gap-2">
                            <input type="checkbox" checked={execute} onChange={(event) => { setExecute(event.target.checked); setVoiceTerminalExecute(event.target.checked) }} />
                            {t('voice.omni.draft.execute')}
                        </label> : null}
                        <span>{t('voice.omni.autoSend.remember')}</span>
                    </div>
                    {props.onKey ? <div className="mt-2 flex flex-wrap gap-1" aria-label={t('terminal.specialKeys')}>
                        {(props.target === 'terminal' ? Object.keys(TERMINAL_KEYS) as TerminalKey[] : ['interrupt'] as TerminalKey[]).map((key) => (
                            <button key={key} type="button" onClick={() => props.onKey?.(key)}
                                aria-label={key === 'interrupt' ? t('terminal.interrupt') : TERMINAL_KEYS[key].label}
                                title={TERMINAL_KEYS[key].phrases[0]}
                                className="rounded border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]">
                                {TERMINAL_KEYS[key].label}
                            </button>
                        ))}
                    </div> : null}
                    <div className="mt-2 flex justify-end gap-2">
                        <button type="button" onClick={props.onClear} disabled={props.sending} className="rounded-full px-3 py-1.5 text-sm text-[var(--app-hint)] disabled:opacity-40">
                            {t('voice.omni.draft.clear')}
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
