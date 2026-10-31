import { useEffect, useRef, useState, type MutableRefObject, type PointerEventHandler } from 'react'
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

/** The AI voice button: a flowing gradient whose motion follows the conversation state and loudness. */
export function VoiceOrb(props: {
    state: OmniVoiceState
    level: MutableRefObject<number>
    onClick: () => void
    onPointerDown?: PointerEventHandler<HTMLButtonElement>
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
            onPointerDown={props.onPointerDown}
            className="voice-orb touch-none"
            style={{ width: size, height: size }}
            title={t(`voice.omni.state.${props.state}`)}
            aria-label={t('voice.omni.toggle')}
            aria-pressed={props.state !== 'off' && props.state !== 'error'}
        >
            <span className="voice-orb-halo" />
            <span className="voice-orb-core">{props.state === 'off' || props.state === 'error' ? <MicGlyph /> : null}</span>
        </button>
    )
}

/** Live captions of the conversation, fading out a few seconds after the last line. */
export function VoiceCaption(props: { caption: OmniCaption | null }) {
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
        <div className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
            <div key={shown.id} className="voice-caption max-w-[min(36rem,92vw)] rounded-2xl bg-[var(--app-bg)]/90 px-4 py-2 text-sm text-[var(--app-fg)] shadow-lg backdrop-blur">
                {shown.role === 'user' ? <span className="mr-1 text-[var(--app-hint)]">{t('voice.omni.you')}</span> : null}
                {text}
            </div>
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
