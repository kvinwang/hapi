import { Database } from 'bun:sqlite'
import { performance } from 'node:perf_hooks'
import { normalizeDecryptedMessage } from '../src/chat/normalize'
import { reconcileChatBlocks } from '../src/chat/reconcile'
import { reduceChatBlocks } from '../src/chat/reducer'
import { buildVisibleChatBlocks, type ToolGroupBlock } from '../src/chat/toolGroups'
import type { NormalizedMessage } from '../src/chat/types'
import { mergeMessages } from '../src/lib/messages'
import type { DecryptedMessage } from '../src/types/api'

type MessageRow = {
    id: string
    content: string
    createdAt: number
    seq: number
    localId: string | null
}

type Sample = {
    meanMs: number
    p95Ms: number
    maxMs: number
}

const windowSizes = [400, 1_000, 2_400]
const iterations = 20

function percentile(values: number[], ratio: number): number {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
}

function measure(run: () => void): Sample {
    run()
    const values: number[] = []
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const startedAt = performance.now()
        run()
        values.push(performance.now() - startedAt)
    }
    return {
        meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
        p95Ms: percentile(values, 0.95),
        maxMs: Math.max(...values)
    }
}

function parseMessage(row: MessageRow): DecryptedMessage {
    return {
        id: row.id,
        seq: row.seq,
        localId: row.localId,
        createdAt: row.createdAt,
        content: JSON.parse(row.content)
    }
}

function normalize(messages: DecryptedMessage[]): NormalizedMessage[] {
    const result: NormalizedMessage[] = []
    for (const message of messages) {
        const normalized = normalizeDecryptedMessage(message)
        if (normalized) result.push(normalized)
    }
    return result
}

function loadWindow(database: Database, size: number): DecryptedMessage[] {
    const session = database.query<{ sessionId: string }, []>(`
        SELECT session_id AS sessionId
        FROM messages
        GROUP BY session_id
        HAVING COUNT(*) >= $size
        ORDER BY COUNT(*) DESC
        LIMIT 1
    `).get({ size })
    if (!session) {
        throw new Error(`No session contains at least ${size} messages`)
    }

    const rows = database.query<MessageRow, [string, number]>(`
        SELECT
            id,
            content,
            created_at AS createdAt,
            seq,
            local_id AS localId
        FROM messages
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?
    `).all(session.sessionId, size)

    return rows.reverse().map(parseMessage)
}

function runWindow(database: Database, size: number) {
    const messages = loadWindow(database, size)
    const normalized = normalize(messages)
    const reduced = reduceChatBlocks(normalized, null)
    const reconciled = reconcileChatBlocks(reduced.blocks, new Map())
    const visible = buildVisibleChatBlocks(reconciled.blocks, {
        hasMoreMessages: false,
        previousGroups: []
    })
    const groups = visible.filter((block): block is ToolGroupBlock => block.kind === 'tool-group')
    const append = {
        ...messages.at(-1)!,
        id: 'benchmark-append',
        seq: (messages.at(-1)?.seq ?? 0) + 1,
        createdAt: (messages.at(-1)?.createdAt ?? 0) + 1
    }

    return {
        rawMessages: messages.length,
        normalizedMessages: normalized.length,
        reducedBlocks: reduced.blocks.length,
        visibleBlocks: visible.length,
        toolGroups: groups.length,
        groupedTools: groups.reduce((sum, group) => sum + group.tools.length, 0),
        timings: {
            mergeSingleAppend: measure(() => {
                mergeMessages(messages, [append])
            }),
            normalizeFullWindow: measure(() => {
                normalize(messages)
            }),
            reduceFullWindow: measure(() => {
                reduceChatBlocks(normalized, null)
            }),
            reconcileFullWindow: measure(() => {
                reconcileChatBlocks(reduced.blocks, new Map())
            }),
            groupFullWindow: measure(() => {
                buildVisibleChatBlocks(reconciled.blocks, {
                    hasMoreMessages: false,
                    previousGroups: []
                })
            })
        }
    }
}

const databasePath = process.env.SESSION_CHAT_BENCHMARK_DB
if (!databasePath) {
    throw new Error('Set SESSION_CHAT_BENCHMARK_DB to a read-only validation snapshot')
}

const database = new Database(databasePath, { readonly: true, strict: true })
try {
    const result = {
        generatedAt: new Date().toISOString(),
        iterations,
        windows: windowSizes.map((size) => runWindow(database, size))
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
    database.close()
}
