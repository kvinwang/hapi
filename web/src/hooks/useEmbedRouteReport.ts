import { useEffect } from 'react'
import type { SessionSummary } from '@/types/api'

/**
 * When the web UI runs inside an iframe of a trusted embedding page (the owner's car dashboard), tell that page which
 * session is open, so it can act on "this conversation". Only the route is shared (session id, its title, machine id and
 * path): never tokens, cookies or message contents. The message is posted with a strict targetOrigin per allowed origin,
 * so the browser delivers it only if the parent really is one of them; any other embedder gets nothing.
 */
const EMBED_PARENT_ORIGINS = ['https://y.kvin.wang:8443']

function isEmbedded(): boolean {
    try {
        return window.parent !== window
    } catch {
        return true
    }
}

/**
 * Embedded by one of the trusted pages (the car dashboard). The parent's origin comes from location.ancestorOrigins
 * (Chromium/WebKit) or, failing that, the referrer. There a touch screen without a hardware keyboard may still report a
 * fine pointer, so the composer must never take focus by itself (it would pop up the on-screen keyboard).
 */
export function isTrustedEmbed(): boolean {
    if (typeof window === 'undefined' || !isEmbedded()) return false
    try {
        const anc = window.location.ancestorOrigins
        if (anc && anc.length > 0) return EMBED_PARENT_ORIGINS.includes(anc[0])
        return document.referrer ? EMBED_PARENT_ORIGINS.includes(new URL(document.referrer).origin) : false
    } catch {
        return false
    }
}

/**
 * The car page marks its frame URL with `embed=car` (a touch screen with no keyboard: typing there would cover the
 * screen; the owner sends from the car only by voice). Remembered for this tab, since the SPA drops the query on
 * navigation: index.html's boot script stores it before the router runs (this function was first called by the
 * composer, after the redirect had already removed the query, so the marker was lost). Honoured only inside a
 * trusted embed. Also evaluated once at module load (below) as a second early capture.
 */
const CAR_KEY = 'hapi-embed-car'
let carEmbed: boolean | null = null

export function isCarEmbed(): boolean {
    if (carEmbed !== null) return carEmbed
    let marked = false
    try {
        marked = new URLSearchParams(window.location.search).get('embed') === 'car'
        if (marked) window.sessionStorage.setItem(CAR_KEY, '1')
        else marked = window.sessionStorage.getItem(CAR_KEY) === '1'
    } catch {
        // storage unavailable: the URL marker alone decides
    }
    carEmbed = marked && isTrustedEmbed()
    return carEmbed
}
isCarEmbed()

function clip(s: string | undefined | null, n: number): string {
    return (s ?? '').slice(0, n)
}

export function useEmbedRouteReport(sessionId: string | null, sessions: SessionSummary[], pathname: string): void {
    const s = sessionId ? sessions.find((x) => x.id === sessionId) : undefined
    const md = s?.metadata
    const title = clip(md?.name || md?.summary?.text || '', 200)
    const machine = clip(md?.machineId, 64)
    const path = clip(md?.path, 300)

    useEffect(() => {
        if (!isEmbedded()) return
        const post = () => {
            const msg = { type: 'hapi-route', sessionId: sessionId ?? null, title, machine, path, route: clip(pathname, 200), carEmbed: isCarEmbed() }
            for (const origin of EMBED_PARENT_ORIGINS) {
                try {
                    window.parent.postMessage(msg, origin)
                } catch {
                    // ignore: the parent is not this origin (delivery is skipped by the browser anyway)
                }
            }
        }
        post()
        const onVisible = () => {
            if (document.visibilityState === 'visible') post()
        }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('pageshow', post)
        return () => {
            document.removeEventListener('visibilitychange', onVisible)
            window.removeEventListener('pageshow', post)
        }
    }, [sessionId, title, machine, path, pathname])
}

export type EmbedNavigate = (to: { sessionId: string } | 'list') => void

const SECRETS: Array<[RegExp, string | ((...a: string[]) => string)]> = [
    [/\b(sk-[a-z0-9_-]{8,}|xte_[a-z0-9_-]{6,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|AKIA[0-9A-Z]{16}|hf_[a-z0-9]{20,}|xox[abp]-[a-z0-9-]{10,}|eyJ[a-z0-9_-]{10,}\.[a-z0-9_.-]+)/gi, '***'],
    [/\b(bearer|authorization:?)\s+\S+/gi, (_m, k) => `${k} ***`],
    [/\b([a-z_]*(?:token|secret|password|passwd|api_?key|cookie|sessdata|credential)[a-z_]*)(\s*[=:]\s*|"\s*:\s*")[^\s"',;]+/gi, (_m, k, sep) => `${k}${sep}***`],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key hidden]'],
    [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '…'],
]

/** Obvious secrets masked, whitespace collapsed, cut to n characters. */
function safeText(s: unknown, n: number): string {
    let t = typeof s === 'string' ? s : ''
    for (const [re, rep] of SECRETS) t = t.replace(re, rep as never)
    t = t.replace(/\s+/g, ' ').trim()
    return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export type EmbedSnapshotSource = {
    sessionId: string | null
    pathname: string
    sessions: SessionSummary[]
    /** The open session's state (agentState.requests = pending permission prompts), if loaded. */
    session: { metadata?: { name?: string; summary?: { text?: string } } | null; agentState?: { requests?: Record<string, { tool: string; arguments: unknown }> | null } | null } | null
    /** Chat messages of the open session as role + text, oldest first; atBottom = the view follows the newest. */
    messages: { items: Array<{ role: string; text: string }>; atBottom: boolean } | null
}

/** What HAPI shows right now, for the embedding page: route, a few visible messages or session titles, pending
 * permission prompt, the composer draft. Text only, secrets masked, every field size-limited (~5 KB in total). */
export function buildEmbedSnapshot(src: EmbedSnapshotSource): Record<string, unknown> {
    const view = src.sessionId ? 'session' : (src.pathname === '/' || src.pathname === '/sessions') ? 'list' : 'other'
    const out: Record<string, unknown> = { type: 'hapi-snapshot', view, route: clip(src.pathname, 200), sessionId: src.sessionId }
    if (src.sessionId) {
        const md = src.session?.metadata ?? src.sessions.find((x) => x.id === src.sessionId)?.metadata
        out.title = safeText(md?.name || md?.summary?.text || '', 200)
        out.visible = (src.messages?.items ?? []).slice(-8).map((m) => ({ role: m.role, text: safeText(m.text, 400) }))
        out.scrolledToBottom = src.messages?.atBottom ?? null
        const reqs = Object.values(src.session?.agentState?.requests ?? {})
        if (reqs.length) {
            const r = reqs[0]
            let summary = ''
            try { summary = JSON.stringify(r.arguments) ?? '' } catch { summary = '' }
            out.pendingPermission = { tool: safeText(r.tool, 60), summary: safeText(summary, 300), count: reqs.length }
        }
    } else if (view === 'list') {
        out.sessions = src.sessions.filter((s) => s.active && !s.metadata?.subagent).slice(0, 15).map((s) => ({
            id: s.id.slice(0, 8),
            title: safeText(s.metadata?.name || s.metadata?.summary?.text || s.metadata?.path || '', 80),
            thinking: s.thinking,
            pending: s.pendingRequestsCount,
        }))
    }
    const ta = document.querySelector<HTMLTextAreaElement>('textarea')
    const draft = ta?.value
    if (draft) out.inputDraft = safeText(draft, 200)
    out.carEmbed = isCarEmbed()
    out.inputDisabled = ta ? ta.disabled : null
    return out
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/

/**
 * Navigation commands from the trusted embedding page: `{type: 'hapi-cmd', cmd, id?, sessionId?}` with cmd
 * open-session | list | reload | focus-input. Accepted only from an allowed origin and only from our direct parent
 * window; nothing here sends messages or reads content (sending stays on the HAPI API). Each command is answered with
 * `{type: 'hapi-ack', cmd, id, ok, error?}` to the sender's origin.
 */
export function useEmbedCommands(navigate: EmbedNavigate, snapshot: () => Record<string, unknown>): void {
    useEffect(() => {
        if (!isEmbedded()) return
        const onMessage = (event: MessageEvent) => {
            if (!EMBED_PARENT_ORIGINS.includes(event.origin) || event.source !== window.parent) return
            const m = event.data
            if (!m || typeof m !== 'object' || m.type !== 'hapi-cmd' || typeof m.cmd !== 'string') return
            const id = typeof m.id === 'string' ? m.id.slice(0, 40) : undefined
            const ack = (ok: boolean, error?: string) => {
                window.parent.postMessage({ type: 'hapi-ack', cmd: m.cmd.slice(0, 20), id, ok, error }, event.origin)
            }
            try {
                if (m.cmd === 'open-session') {
                    if (typeof m.sessionId !== 'string' || !SESSION_ID.test(m.sessionId)) return ack(false, 'bad sessionId')
                    navigate({ sessionId: m.sessionId })
                    ack(true)
                } else if (m.cmd === 'list') {
                    navigate('list')
                    ack(true)
                } else if (m.cmd === 'reload') {
                    ack(true)
                    setTimeout(() => window.location.reload(), 50)
                } else if (m.cmd === 'snapshot') {
                    window.parent.postMessage({ ...snapshot(), id }, event.origin)
                } else if (m.cmd === 'focus-input') {
                    if (isCarEmbed()) return ack(false, 'input disabled in the car')
                    const el = document.querySelector<HTMLTextAreaElement>('textarea')
                    el?.focus()
                    ack(Boolean(el), el ? undefined : 'no input')
                } else {
                    ack(false, 'unknown command')
                }
            } catch {
                ack(false, 'failed')
            }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
    }, [navigate, snapshot])
}
