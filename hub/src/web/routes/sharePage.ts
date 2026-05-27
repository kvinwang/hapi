import { Hono } from 'hono'
import { asString, isObject, safeStringify } from '@hapi/protocol'
import { isClaudeChatVisibleMessage, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Store } from '../../store'
import type { StoredMessage, StoredSession } from '../../store/types'

type ShareEnv = {
    Variables: Record<string, never>
}

type RenderedText = { type: 'text'; text: string }
type RenderedReasoning = { type: 'reasoning'; text: string }
type RenderedToolResult = {
    type: 'tool_result'
    tool_use_id: string
    content: unknown
    is_error: boolean
}
type RenderedToolUse = {
    type: 'tool_use'
    id: string
    name: string
    input: unknown
    description: string | null
    result: RenderedToolResult | null
}
type RenderedEvent = { type: 'event'; event: string; details?: Record<string, unknown> }
type RenderedSummary = { type: 'summary'; summary: string }

type RenderedBlock = RenderedText | RenderedReasoning | RenderedToolUse | RenderedEvent | RenderedSummary

type RenderedMessage = {
    id: string
    seq: number
    createdAt: number
    role: 'user' | 'assistant' | 'event'
    model?: string
    blocks: RenderedBlock[]
}

type RenderedSessionMeta = {
    id: string
    title: string
    flavor: string | null
    createdAt: number
    updatedAt: number
    active: boolean
}

type RenderedShare = {
    session: RenderedSessionMeta
    messages: RenderedMessage[]
}

function getSessionTitle(metadata: Record<string, unknown> | null): string {
    if (!metadata) return 'Shared Session'
    if (typeof metadata.name === 'string' && metadata.name) return metadata.name
    const summary = metadata.summary as Record<string, unknown> | undefined
    if (summary && typeof summary.text === 'string' && summary.text) return summary.text
    if (typeof metadata.path === 'string' && metadata.path) {
        const parts = metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : 'Shared Session'
    }
    return 'Shared Session'
}

function buildSessionMeta(session: StoredSession): RenderedSessionMeta {
    const metadata = session.metadata as Record<string, unknown> | null
    const flavor = metadata && typeof metadata.flavor === 'string' ? metadata.flavor : null
    return {
        id: session.id,
        title: getSessionTitle(metadata),
        flavor,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        active: session.active
    }
}

/** Walk all messages once and collect tool_result blocks keyed by their tool_use_id. */
function buildToolResultMap(messages: StoredMessage[]): Map<string, RenderedToolResult> {
    const map = new Map<string, RenderedToolResult>()
    for (const m of messages) {
        const record = unwrapRoleWrappedRecordEnvelope(m.content)
        if (!record || record.role !== 'agent') continue
        if (!isObject(record.content)) continue

        // Claude protocol: agent message with type=output, data.type=user contains tool_result blocks.
        if (record.content.type === 'output') {
            const data = isObject(record.content.data) ? record.content.data : null
            if (!data || data.type !== 'user') continue
            const message = isObject(data.message) ? data.message : null
            if (!message || !Array.isArray(message.content)) continue
            const embeddedToolUseResult = (data as Record<string, unknown>).toolUseResult
            for (const block of message.content) {
                if (!isObject(block)) continue
                if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                    const raw = 'content' in block ? (block as Record<string, unknown>).content : undefined
                    map.set(block.tool_use_id, {
                        type: 'tool_result',
                        tool_use_id: block.tool_use_id,
                        content: embeddedToolUseResult ?? raw,
                        is_error: Boolean(block.is_error)
                    })
                }
            }
            continue
        }

        // Codex protocol: tool-call-result wrappers.
        if (record.content.type === 'codex') {
            const data = isObject(record.content.data) ? record.content.data : null
            if (!data || data.type !== 'tool-call-result') continue
            if (typeof data.callId !== 'string') continue
            const output = (data as Record<string, unknown>).output
            const isError = isObject(output) && (
                (typeof output.error === 'string' && output.error.trim().length > 0) ||
                (typeof output.status === 'string' && (output.status === 'failed' || output.status === 'error'))
            )
            map.set(data.callId, {
                type: 'tool_result',
                tool_use_id: data.callId,
                content: output,
                is_error: Boolean(isError)
            })
        }
    }
    return map
}

function buildRenderedMessages(messages: StoredMessage[]): RenderedMessage[] {
    const toolResults = buildToolResultMap(messages)
    const out: RenderedMessage[] = []

    for (const m of messages) {
        const record = unwrapRoleWrappedRecordEnvelope(m.content)
        if (!record) continue

        if (record.role === 'user') {
            let text: string | null = null
            if (typeof record.content === 'string') {
                text = record.content
            } else if (isObject(record.content) && record.content.type === 'text' && typeof record.content.text === 'string') {
                text = record.content.text
            }
            if (text === null) continue
            out.push({
                id: m.id,
                seq: m.seq,
                createdAt: m.createdAt,
                role: 'user',
                blocks: [{ type: 'text', text }]
            })
            continue
        }

        if (record.role !== 'agent') continue
        if (!isObject(record.content)) continue

        if (record.content.type === 'output') {
            const data = isObject(record.content.data) ? record.content.data : null
            if (!data || typeof data.type !== 'string') continue
            if (data.isMeta || data.isCompactSummary) continue
            if (!isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })) continue

            if (data.type === 'assistant') {
                const message = isObject(data.message) ? data.message : null
                if (!message) continue
                const blocks: RenderedBlock[] = []
                const modelContent = message.content
                if (typeof modelContent === 'string' && modelContent.length > 0) {
                    blocks.push({ type: 'text', text: modelContent })
                } else if (Array.isArray(modelContent)) {
                    for (const block of modelContent) {
                        if (!isObject(block) || typeof block.type !== 'string') continue
                        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
                            blocks.push({ type: 'text', text: block.text })
                        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
                            blocks.push({ type: 'reasoning', text: block.thinking })
                        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
                            const name = asString(block.name) ?? 'Tool'
                            const input = 'input' in block ? (block as Record<string, unknown>).input : undefined
                            const description = isObject(input) && typeof input.description === 'string' ? input.description : null
                            blocks.push({
                                type: 'tool_use',
                                id: block.id,
                                name,
                                input,
                                description,
                                result: toolResults.get(block.id) ?? null
                            })
                        }
                    }
                }
                if (blocks.length === 0) continue
                out.push({
                    id: m.id,
                    seq: m.seq,
                    createdAt: m.createdAt,
                    role: 'assistant',
                    blocks,
                    model: asString(message.model) ?? undefined
                })
                continue
            }

            // Tool result messages are surfaced inline with their matching tool_use; skip standalone.
            if (data.type === 'user') continue

            if (data.type === 'summary' && typeof data.summary === 'string') {
                out.push({
                    id: m.id, seq: m.seq, createdAt: m.createdAt, role: 'event',
                    blocks: [{ type: 'summary', summary: data.summary }]
                })
                continue
            }

            if (data.type === 'system') {
                const subtype = asString(data.subtype) ?? ''
                if (subtype === 'api_error') {
                    out.push({
                        id: m.id, seq: m.seq, createdAt: m.createdAt, role: 'event',
                        blocks: [{ type: 'event', event: 'api_error', details: { error: (data as Record<string, unknown>).error } }]
                    })
                }
                continue
            }
            continue
        }

        if (record.content.type === 'codex') {
            const data = isObject(record.content.data) ? record.content.data : null
            if (!data || typeof data.type !== 'string') continue

            if (data.type === 'message' && typeof data.message === 'string' && data.message.length > 0) {
                out.push({
                    id: m.id, seq: m.seq, createdAt: m.createdAt, role: 'assistant',
                    blocks: [{ type: 'text', text: data.message }]
                })
                continue
            }
            if (data.type === 'reasoning' && typeof data.message === 'string' && data.message.length > 0) {
                out.push({
                    id: m.id, seq: m.seq, createdAt: m.createdAt, role: 'assistant',
                    blocks: [{ type: 'reasoning', text: data.message }]
                })
                continue
            }
            if (data.type === 'tool-call' && typeof data.callId === 'string') {
                out.push({
                    id: m.id, seq: m.seq, createdAt: m.createdAt, role: 'assistant',
                    blocks: [{
                        type: 'tool_use',
                        id: data.callId,
                        name: asString(data.name) ?? 'tool',
                        input: (data as Record<string, unknown>).input,
                        description: null,
                        result: toolResults.get(data.callId) ?? null
                    }]
                })
            }
            continue
        }

        if (record.content.type === 'event') {
            const event = isObject(record.content.data) ? record.content.data : null
            if (!event || typeof event.type !== 'string') continue
            const details: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(event)) {
                if (k !== 'type') details[k] = v
            }
            out.push({
                id: m.id, seq: m.seq, createdAt: m.createdAt, role: 'event',
                blocks: [{ type: 'event', event: event.type, details }]
            })
        }
    }

    return out
}

function fenceFor(text: string): string {
    let fence = '```'
    while (text.includes(fence)) fence += '`'
    return fence
}

function codeBlock(text: string, lang: string = ''): string {
    const fence = fenceFor(text)
    return `${fence}${lang}\n${text}\n${fence}`
}

function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        const parts: string[] = []
        for (const item of content) {
            if (isObject(item) && item.type === 'text' && typeof item.text === 'string') {
                parts.push(item.text)
            } else if (typeof item === 'string') {
                parts.push(item)
            } else {
                parts.push(safeStringify(item))
            }
        }
        return parts.join('\n')
    }
    if (isObject(content)) {
        // toolUseResult shapes vary; if there's a stdout field, prefer it.
        if (typeof content.stdout === 'string' && content.stdout.length > 0) {
            return content.stdout
        }
        if (typeof content.output === 'string' && content.output.length > 0) {
            return content.output
        }
        if (typeof content.text === 'string') return content.text
    }
    return safeStringify(content)
}

function isoTime(ms: number): string {
    return new Date(ms).toISOString()
}

export function renderShareMarkdown(rendered: RenderedShare): string {
    const { session, messages } = rendered
    const out: string[] = []

    out.push(`# ${session.title}`)
    out.push('')
    out.push(`- Session: \`${session.id}\``)
    if (session.flavor) out.push(`- Flavor: ${session.flavor}`)
    out.push(`- Created: ${isoTime(session.createdAt)}`)
    out.push(`- Updated: ${isoTime(session.updatedAt)}`)
    out.push(`- Messages: ${messages.length}`)
    out.push('')

    for (const m of messages) {
        out.push('---')
        out.push('')
        if (m.role === 'user') {
            out.push('## User')
        } else if (m.role === 'assistant') {
            out.push(m.model ? `## Assistant (${m.model})` : '## Assistant')
        } else {
            out.push('## Event')
        }
        out.push('')

        for (const b of m.blocks) {
            if (b.type === 'text') {
                out.push(b.text)
                out.push('')
            } else if (b.type === 'reasoning') {
                out.push('<details><summary>Reasoning</summary>')
                out.push('')
                out.push(b.text)
                out.push('')
                out.push('</details>')
                out.push('')
            } else if (b.type === 'tool_use') {
                const header = b.description ? `### Tool: ${b.name} — ${b.description}` : `### Tool: ${b.name}`
                out.push(header)
                out.push('')
                out.push('Input:')
                out.push('')
                out.push(codeBlock(safeStringify(b.input ?? {}), 'json'))
                out.push('')
                if (b.result) {
                    out.push(b.result.is_error ? 'Result (error):' : 'Result:')
                    out.push('')
                    out.push(codeBlock(toolResultText(b.result.content)))
                    out.push('')
                }
            } else if (b.type === 'summary') {
                out.push(`> **Summary:** ${b.summary}`)
                out.push('')
            } else if (b.type === 'event') {
                out.push(`> _Event: ${b.event}_`)
                if (b.details && Object.keys(b.details).length > 0) {
                    out.push('')
                    out.push(codeBlock(safeStringify(b.details), 'json'))
                }
                out.push('')
            }
        }
    }

    return out.join('\n')
}

export function renderShareData(session: StoredSession, messages: StoredMessage[]): RenderedShare {
    return {
        session: buildSessionMeta(session),
        messages: buildRenderedMessages(messages)
    }
}

/** Load every message for a session. Uses the existing paginated query in a loop. */
function loadAllMessages(store: Store, sessionId: string): StoredMessage[] {
    const PAGE = 200
    const all: StoredMessage[] = []
    let afterSeq = 0
    while (true) {
        const batch = store.messages.getMessagesAfter(sessionId, afterSeq, PAGE)
        if (batch.length === 0) break
        all.push(...batch)
        if (batch.length < PAGE) break
        afterSeq = batch[batch.length - 1].seq
    }
    return all
}

type Fmt = 'md' | 'json' | 'html'

function parseFmt(raw: string | undefined): Fmt | null {
    if (!raw) return null
    const v = raw.toLowerCase()
    if (v === 'md' || v === 'markdown') return 'md'
    if (v === 'json') return 'json'
    if (v === 'html') return 'html'
    return null
}

// Browsers send `Accept: text/html,...`; curl/wget/SDKs send `*\/*` or app-specific types.
function clientWantsHtml(accept: string | undefined): boolean {
    if (!accept) return false
    return accept.toLowerCase().includes('text/html')
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export function renderShareHtml(rendered: RenderedShare): string {
    const { session, messages } = rendered
    const parts: string[] = []

    parts.push('<!DOCTYPE html>')
    parts.push('<html lang="en"><head>')
    parts.push('<meta charset="utf-8">')
    parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">')
    parts.push(`<title>${escapeHtml(session.title)}</title>`)
    parts.push('<style>')
    parts.push(`
:root { color-scheme: light dark; }
body { font: 15px/1.55 system-ui, -apple-system, Segoe UI, sans-serif; max-width: 920px; margin: 2rem auto; padding: 0 1rem; }
h1 { margin: 0 0 .5rem; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; margin: 0 0 1.5rem; font-size: 13px; opacity: .8; }
dl.meta dt { font-weight: 600; }
dl.meta dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
section.message { border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: 1rem 0; }
section.message h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 0 0 .6rem; }
section.message.user h2 { color: #2563eb; }
section.message.assistant h2 { color: #15803d; }
section.message.event h2 { color: #92400e; }
.text { white-space: pre-wrap; word-wrap: break-word; }
details.reasoning { margin: .5rem 0; }
details.reasoning > summary { cursor: pointer; opacity: .7; }
details.reasoning .text { margin-top: .5rem; padding-left: .75rem; border-left: 2px solid color-mix(in srgb, currentColor 25%, transparent); opacity: .85; }
section.tool { margin: .75rem 0; padding: .6rem .8rem; border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 6px; }
section.tool h3 { font-size: 14px; margin: 0 0 .4rem; }
section.tool .label { font-size: 12px; opacity: .65; margin-top: .5rem; }
pre { background: color-mix(in srgb, currentColor 6%, transparent); padding: .6rem .8rem; border-radius: 4px; overflow-x: auto; font-size: 13px; margin: .25rem 0 0; }
pre.error { background: color-mix(in srgb, #dc2626 12%, transparent); }
blockquote.summary { border-left: 3px solid #2563eb; margin: 0; padding: .25rem 0 .25rem .75rem; font-style: italic; }
.event-name { font-style: italic; opacity: .7; }
`)
    parts.push('</style>')
    parts.push('</head><body>')

    parts.push(`<h1>${escapeHtml(session.title)}</h1>`)
    parts.push('<dl class="meta">')
    parts.push(`<dt>Session</dt><dd>${escapeHtml(session.id)}</dd>`)
    if (session.flavor) {
        parts.push(`<dt>Flavor</dt><dd>${escapeHtml(session.flavor)}</dd>`)
    }
    parts.push(`<dt>Created</dt><dd>${escapeHtml(isoTime(session.createdAt))}</dd>`)
    parts.push(`<dt>Updated</dt><dd>${escapeHtml(isoTime(session.updatedAt))}</dd>`)
    parts.push(`<dt>Messages</dt><dd>${messages.length}</dd>`)
    parts.push('</dl>')

    for (const m of messages) {
        parts.push(`<section class="message ${m.role}">`)
        if (m.role === 'user') {
            parts.push('<h2>User</h2>')
        } else if (m.role === 'assistant') {
            parts.push(m.model ? `<h2>Assistant <small>(${escapeHtml(m.model)})</small></h2>` : '<h2>Assistant</h2>')
        } else {
            parts.push('<h2>Event</h2>')
        }

        for (const b of m.blocks) {
            if (b.type === 'text') {
                parts.push(`<div class="text">${escapeHtml(b.text)}</div>`)
            } else if (b.type === 'reasoning') {
                parts.push('<details class="reasoning"><summary>Reasoning</summary>')
                parts.push(`<div class="text">${escapeHtml(b.text)}</div>`)
                parts.push('</details>')
            } else if (b.type === 'tool_use') {
                parts.push('<section class="tool">')
                const heading = b.description
                    ? `${escapeHtml(b.name)} — ${escapeHtml(b.description)}`
                    : escapeHtml(b.name)
                parts.push(`<h3>Tool: ${heading}</h3>`)
                parts.push('<div class="label">Input</div>')
                parts.push(`<pre><code>${escapeHtml(safeStringify(b.input ?? {}))}</code></pre>`)
                if (b.result) {
                    parts.push(`<div class="label">${b.result.is_error ? 'Result (error)' : 'Result'}</div>`)
                    const cls = b.result.is_error ? 'pre error' : 'pre'
                    parts.push(`<pre class="${cls}"><code>${escapeHtml(toolResultText(b.result.content))}</code></pre>`)
                }
                parts.push('</section>')
            } else if (b.type === 'summary') {
                parts.push(`<blockquote class="summary"><strong>Summary:</strong> ${escapeHtml(b.summary)}</blockquote>`)
            } else if (b.type === 'event') {
                parts.push(`<div><span class="event-name">Event: ${escapeHtml(b.event)}</span></div>`)
                if (b.details && Object.keys(b.details).length > 0) {
                    parts.push(`<pre><code>${escapeHtml(safeStringify(b.details))}</code></pre>`)
                }
            }
        }
        parts.push('</section>')
    }

    parts.push('</body></html>')
    return parts.join('\n')
}

/**
 * Server-side renderer at `/shared/:token` for AI-friendly consumption.
 *
 * - `?fmt=md` (or `markdown`)  → `text/markdown` body
 * - `?fmt=json`                → JSON body with session + normalized messages
 * - `?fmt=html`                → standalone HTML document
 * - no `fmt`: content-negotiate via `Accept` header:
 *     - browsers (Accept contains `text/html`) → defer to SPA via `next()`
 *     - everyone else (curl, SDKs, AIs) → markdown
 *
 * `full=1` is implicit here: the server always returns the entire conversation.
 */
export function createSharePageRoutes(store: Store): Hono<ShareEnv> {
    const app = new Hono<ShareEnv>()

    app.get('/shared/:token', async (c, next) => {
        const explicitFmt = parseFmt(c.req.query('fmt'))
        const fmt: Fmt | null = explicitFmt ?? (clientWantsHtml(c.req.header('accept')) ? null : 'md')
        if (!fmt) {
            return next()
        }

        const token = c.req.param('token')
        const session = store.sessions.getSession(token)
        if (!session || !session.shareToken) {
            if (fmt === 'json') {
                return c.json({ error: 'Shared session not found' }, 404)
            }
            if (fmt === 'html') {
                return c.html('<!DOCTYPE html><meta charset="utf-8"><title>Not found</title><p>Shared session not found.</p>', 404)
            }
            return c.text('Shared session not found\n', 404, {
                'Content-Type': 'text/plain; charset=utf-8'
            })
        }

        const allMessages = loadAllMessages(store, session.id)
        const rendered = renderShareData(session, allMessages)

        if (fmt === 'json') {
            return c.json(rendered)
        }
        if (fmt === 'html') {
            return c.html(renderShareHtml(rendered))
        }

        return c.body(renderShareMarkdown(rendered), 200, {
            'Content-Type': 'text/markdown; charset=utf-8'
        })
    })

    return app
}

// Re-exported for tests / external consumers.
export type { RenderedShare, RenderedMessage, RenderedBlock, RenderedSessionMeta }
