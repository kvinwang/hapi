import {
    buildToolGroupContent,
    classifyToolRunMessage,
    collectToolGroupDescriptors,
    findToolRuns,
    type ToolRunKind
} from './toolRun'
import type { ChatSourceMessage } from './types'

/**
 * A page never cuts through a run of consecutive tool calls.
 *
 * The web client packs such a run into a single tool-group card. If a page
 * boundary fell inside the run, loading older history would change that card's
 * membership — and therefore its height and identity — right above the reading
 * position, which is what makes the viewport jump. Expanding the page to whole
 * runs removes the cause instead of compensating for the symptom.
 *
 * A complete run is then delivered as one compacted `tool-group` message, so a
 * few hundred tool calls cost a few kilobytes instead of megabytes of results.
 */

/** Messages pulled per expansion step while chasing a run boundary. */
const EXPAND_BATCH_SIZE = 100

/**
 * Upper bound on messages pulled in to complete one run. A run longer than this
 * is cut (the old behaviour) rather than letting one request read the whole
 * session; runs this long do not occur in practice.
 */
const MAX_EXPAND_MESSAGES = 1_000

export type ToolGroupPageLoader = {
    /** Messages strictly older than `seq`, ascending, newest-anchored. */
    loadBefore: (seq: number, limit: number) => ChatSourceMessage[]
    /** Messages strictly newer than `seq`, ascending. */
    loadAfter: (seq: number, limit: number) => ChatSourceMessage[]
}

function classify(messages: readonly ChatSourceMessage[]): ToolRunKind[] {
    return messages.map((message) => classifyToolRunMessage(message))
}

/** True when a run of tool activity touches the array edge at `side`. */
function runTouchesEdge(kinds: readonly ToolRunKind[], side: 'start' | 'end'): boolean {
    const step = side === 'start' ? 1 : -1
    let index = side === 'start' ? 0 : kinds.length - 1
    while (index >= 0 && index < kinds.length) {
        const kind = kinds[index]
        if (kind === 'boundary') return false
        if (kind === 'tool') return true
        index += step
    }
    return false
}

/**
 * Grow a page backwards until its first message starts a run, then trim the
 * extra context back to that run start.
 */
export function expandPageStartToRunBoundary(
    page: ChatSourceMessage[],
    loader: ToolGroupPageLoader
): ChatSourceMessage[] {
    if (page.length === 0) return page
    if (!runTouchesEdge(classify(page), 'start')) return page

    let messages = page
    let fetched = 0
    while (fetched < MAX_EXPAND_MESSAGES) {
        const oldest = messages[0]
        if (typeof oldest.seq !== 'number') break

        const older = loader.loadBefore(oldest.seq, EXPAND_BATCH_SIZE)
        if (older.length === 0) break
        fetched += older.length
        const olderKinds = classify(older)
        messages = [...older, ...messages]

        for (let index = older.length - 1; index >= 0; index -= 1) {
            if (olderKinds[index] === 'boundary') return messages.slice(index + 1)
        }
    }
    return messages
}

/**
 * Grow a page forwards until its last message ends a run, then trim the extra
 * context back to that run end.
 */
export function expandPageEndToRunBoundary(
    page: ChatSourceMessage[],
    loader: ToolGroupPageLoader
): ChatSourceMessage[] {
    if (page.length === 0) return page
    if (!runTouchesEdge(classify(page), 'end')) return page

    let messages = page
    let fetched = 0
    while (fetched < MAX_EXPAND_MESSAGES) {
        const newest = messages[messages.length - 1]
        if (typeof newest.seq !== 'number') break

        const newer = loader.loadAfter(newest.seq, EXPAND_BATCH_SIZE)
        if (newer.length === 0) break
        fetched += newer.length
        const newerKinds = classify(newer)
        const offset = messages.length
        messages = [...messages, ...newer]

        for (let index = 0; index < newer.length; index += 1) {
            if (newerKinds[index] === 'boundary') return messages.slice(0, offset + index)
        }
    }
    return messages
}

/**
 * Replace every complete tool run of two or more tools with a single compacted
 * message. A run that reaches the newest message of the session is left raw:
 * it can still grow, and the client must be free to append live tool calls to
 * the card it already rendered.
 */
export function compactToolRuns(
    messages: readonly ChatSourceMessage[],
    options: { sessionMaxSeq: number }
): ChatSourceMessage[] {
    if (messages.length === 0) return [...messages]
    const kinds = classify(messages)
    const runs = findToolRuns(kinds)
    if (runs.length === 0) return [...messages]

    const compactedByStart = new Map<number, ChatSourceMessage>()
    const skipped = new Set<number>()

    for (const run of runs) {
        const slice = messages.slice(run.start, run.end + 1)
        const first = slice[0]
        const last = slice[slice.length - 1]
        if (typeof first.seq !== 'number' || typeof last.seq !== 'number') continue
        if (last.seq >= options.sessionMaxSeq) continue

        const descriptors = collectToolGroupDescriptors(slice)
        if (!descriptors) continue

        compactedByStart.set(run.start, {
            id: `tool-group:${first.id}`,
            seq: first.seq,
            localId: null,
            createdAt: first.createdAt,
            content: {
                role: 'agent',
                content: buildToolGroupContent(descriptors, first.seq, last.seq)
            }
        })
        for (let index = run.start; index <= run.end; index += 1) skipped.add(index)
    }

    const output: ChatSourceMessage[] = []
    for (let index = 0; index < messages.length; index += 1) {
        const compacted = compactedByStart.get(index)
        if (compacted) {
            output.push(compacted)
            continue
        }
        if (skipped.has(index)) continue
        output.push(messages[index])
    }
    return output
}
