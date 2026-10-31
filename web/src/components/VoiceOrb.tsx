import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { OmniCaption, OmniVoiceState } from '@/hooks/useOmniVoice'
import { useTranslation } from '@/lib/use-translation'

const EDGE_GLOW_KEY = 'hapi.voiceEdgeGlow'
const KNOWN_NOTES = new Set(['idle', 'micPermission', 'notConfigured'])

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

const READ_REPLIES_KEY = 'hapi.voiceReadReplies'

/** Whether Omni reads the agent's replies aloud (default) or only says it is done. */
export function isVoiceReadRepliesEnabled(): boolean {
    return localStorage.getItem(READ_REPLIES_KEY) !== '0'
}

export function setVoiceReadRepliesEnabled(on: boolean): void {
    localStorage.setItem(READ_REPLIES_KEY, on ? '1' : '0')
}

/** Mirrors `level` into the element's `--orb-level` every frame, without re-rendering. */
function useLevelVar(ref: MutableRefObject<HTMLElement | null>, level: MutableRefObject<number>, active: boolean) {
    useEffect(() => {
        const el = ref.current
        if (!el || !active) return
        let smooth = 0
        let frame = 0
        const tick = () => {
            smooth += (level.current - smooth) * 0.3
            el.style.setProperty('--orb-level', smooth.toFixed(3))
            frame = requestAnimationFrame(tick)
        }
        tick()
        return () => {
            cancelAnimationFrame(frame)
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
    drafting: boolean
    sending: boolean
    onSend: () => void
    onClear: () => void
}) {
    const { t } = useTranslation()
    const showDraft = props.draft !== '' || props.drafting
    return (
        <div className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
            <VoiceCaption caption={props.caption} />
            {showDraft ? (
                <div className="voice-caption pointer-events-auto w-[min(36rem,92vw)] rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)]/95 p-3 text-[var(--app-fg)] shadow-xl backdrop-blur">
                    <div className="mb-1 flex items-center gap-2 text-xs text-[var(--app-hint)]">
                        <span>{t('voice.omni.draft.title')}</span>
                        {props.drafting ? <span className="animate-pulse">{t('voice.omni.draft.drafting')}</span> : null}
                    </div>
                    <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm">{props.draft}</div>
                    <div className="mt-2 flex justify-end gap-2">
                        <button type="button" onClick={props.onClear} disabled={props.sending} className="rounded-full px-3 py-1.5 text-sm text-[var(--app-hint)] disabled:opacity-40">
                            {t('voice.omni.draft.clear')}
                        </button>
                        <button type="button" onClick={props.onSend} disabled={!props.draft || props.sending} className="rounded-full bg-[var(--app-button)] px-4 py-1.5 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-40">
                            {t('voice.omni.draft.send')}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

/** Optional gradient light along the screen edges while a conversation runs. */
export function VoiceEdgeGlow(props: { state: OmniVoiceState; level: MutableRefObject<number> }) {
    const ref = useRef<HTMLDivElement | null>(null)
    const on = props.state !== 'off' && props.state !== 'error'
    useLevelVar(ref, props.level, on)
    if (!on) return null
    return <div ref={ref} data-state={props.state} className="voice-edge" aria-hidden="true" />
}
