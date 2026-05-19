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

type Fmt = 'md' | 'json' | null

function parseFmt(raw: string | undefined): Fmt {
    if (!raw) return null
    const v = raw.toLowerCase()
    if (v === 'md' || v === 'markdown') return 'md'
    if (v === 'json') return 'json'
    return null
}

/**
 * Server-side renderer at `/shared/:token` for AI-friendly consumption.
 *
 * - `?fmt=md` (or `markdown`)  → `text/markdown` body
 * - `?fmt=json`                → JSON body with session + normalized messages
 * - no `fmt` (or unknown value) → defers to the SPA via `next()`
 *
 * `full=1` is implicit here: the server always returns the entire conversation.
 */
export function createSharePageRoutes(store: Store): Hono<ShareEnv> {
    const app = new Hono<ShareEnv>()

    app.get('/shared/:token', async (c, next) => {
        const fmt = parseFmt(c.req.query('fmt'))
        if (!fmt) {
            return next()
        }

        const token = c.req.param('token')
        const session = store.sessions.getSession(token)
        if (!session || !session.shareToken) {
            if (fmt === 'json') {
                return c.json({ error: 'Shared session not found' }, 404)
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

        return c.body(renderShareMarkdown(rendered), 200, {
            'Content-Type': 'text/markdown; charset=utf-8'
        })
    })

    return app
}

// Re-exported for tests / external consumers.
export type { RenderedShare, RenderedMessage, RenderedBlock, RenderedSessionMeta }
