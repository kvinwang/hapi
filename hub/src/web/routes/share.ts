import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'

type ShareEnv = {
    Variables: Record<string, never>
}

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(),
    afterSeq: z.coerce.number().int().min(0).optional()
})

type ContentBlock = { type?: string; id?: string; tool_use_id?: string }

/** Extract the inner content blocks from a message's nested structure */
function extractContentBlocks(content: unknown): ContentBlock[] {
    if (!content || typeof content !== 'object') return []
    const outer = content as Record<string, unknown>
    // Nested: {role, content: {type: "output", data: {message: {content: [...]}}}}
    const inner = outer.content
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const typed = inner as Record<string, unknown>
        if (typed.type === 'output' && typed.data && typeof typed.data === 'object') {
            const data = typed.data as Record<string, unknown>
            const message = data.message as Record<string, unknown> | undefined
            if (message && Array.isArray(message.content)) {
                return message.content as ContentBlock[]
            }
        }
    }
    return []
}

/** Find tool_use IDs at the tail of the batch that have no matching tool_result.
 *  Only scans the last `tailSize` messages to avoid catching long-running subagent calls. */
function findTailPendingToolUseIds(messages: Array<{ content: unknown }>, tailSize = 10): Set<string> {
    // Collect all tool_result IDs from the entire batch
    const toolResultIds = new Set<string>()
    for (const m of messages) {
        for (const block of extractContentBlocks(m.content)) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                toolResultIds.add(block.tool_use_id)
            }
        }
    }
    // Only check tool_use in the tail for pending ones
    const tailStart = Math.max(0, messages.length - tailSize)
    const pending = new Set<string>()
    for (let i = tailStart; i < messages.length; i++) {
        for (const block of extractContentBlocks(messages[i].content)) {
            if (block.type === 'tool_use' && typeof block.id === 'string' && !toolResultIds.has(block.id)) {
                pending.add(block.id)
            }
        }
    }
    return pending
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

export function createShareRoutes(store: Store): Hono<ShareEnv> {
    const app = new Hono<ShareEnv>()

    app.get('/share/:token', (c) => {
        const token = c.req.param('token')
        // Look up by session ID, verify sharing is enabled
        const session = store.sessions.getSession(token)
        if (!session || !session.shareToken) {
            return c.json({ error: 'Shared session not found' }, 404)
        }

        const metadata = session.metadata as Record<string, unknown> | null

        return c.json({
            session: {
                id: session.id,
                title: getSessionTitle(metadata),
                flavor: metadata?.flavor ?? null,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                active: session.active
            }
        })
    })

    app.get('/share/:token/messages', (c) => {
        const token = c.req.param('token')
        const session = store.sessions.getSession(token)
        if (!session || !session.shareToken) {
            return c.json({ error: 'Shared session not found' }, 404)
        }

        const parsed = querySchema.safeParse(c.req.query())
        const limit = parsed.success ? (parsed.data.limit ?? 50) : 50
        const beforeSeq = parsed.success ? (parsed.data.beforeSeq ?? undefined) : undefined
        const afterSeq = parsed.success ? (parsed.data.afterSeq ?? undefined) : undefined

        // afterSeq: load messages after seq (forward direction, oldest→newest)
        // beforeSeq: load messages before seq (backward direction, newest→oldest)
        let messages = afterSeq !== undefined
            ? store.messages.getMessagesAfter(session.id, afterSeq, limit)
            : store.messages.getMessages(session.id, limit, beforeSeq)

        let hasMore = messages.length === limit

        // Ensure tool call boundaries: if any tool_use has no matching tool_result,
        // fetch a few more messages to complete the pair
        if (hasMore && messages.length > 0) {
            const pending = findTailPendingToolUseIds(messages)
            if (pending.size > 0) {
                const lastSeq = messages[messages.length - 1].seq
                const extra = store.messages.getMessagesAfter(session.id, lastSeq, 20)
                for (const m of extra) {
                    messages.push(m)
                    for (const block of extractContentBlocks(m.content)) {
                        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                            pending.delete(block.tool_use_id)
                        }
                    }
                    if (pending.size === 0) break
                }
                // Recompute: there are more messages if the extra batch was full
                // (meaning there could be even more beyond)
                hasMore = extra.length === 20
            }
        }

        return c.json({
            messages: messages.map((m) => ({
                id: m.id,
                sessionId: m.sessionId,
                content: m.content,
                createdAt: m.createdAt,
                seq: m.seq,
                localId: m.localId ?? null
            })),
            page: {
                limit,
                beforeSeq: beforeSeq ?? null,
                afterSeq: afterSeq ?? null,
                hasMore
            }
        })
    })

    return app
}
