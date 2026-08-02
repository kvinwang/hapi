import { normalizeDecryptedMessage, type ChatSourceMessage, type NormalizedMessage } from '@hapi/protocol/chat'
import type { SessionHistoryMessage } from '@/api/types'

export type SessionInspectArgs = {
    sessionId: string
    seq: number
    format: 'text' | 'json'
    raw: boolean
}

export type ToolInspection = {
    id: string
    name: string
    callSeq: number
    resultSeq: number | null
    input: unknown
    result: unknown
    isError: boolean | null
}

function readValue(args: string[], arg: string, index: number): { value: string; nextIndex: number } {
    const separator = arg.indexOf('=')
    if (separator >= 0) return { value: arg.slice(separator + 1), nextIndex: index }
    const value = args[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    return { value, nextIndex: index + 1 }
}

export function parseSessionInspectArgs(args: string[], environment: NodeJS.ProcessEnv = process.env): SessionInspectArgs {
    let sessionId = environment.HAPI_SESSION_ID?.trim() ?? ''
    let seq: number | null = null
    let format: 'text' | 'json' = 'text'
    let raw = false

    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index]
        if (arg === '--raw') {
            raw = true
            continue
        }
        if (arg === '--session' || arg === '-s' || arg.startsWith('--session=')) {
            const parsed = readValue(args, arg, index)
            sessionId = parsed.value.trim()
            index = parsed.nextIndex
            continue
        }
        if (arg === '--format' || arg.startsWith('--format=')) {
            const parsed = readValue(args, arg, index)
            if (parsed.value !== 'text' && parsed.value !== 'json') {
                throw new Error('--format must be text or json')
            }
            format = parsed.value
            index = parsed.nextIndex
            continue
        }
        if (!arg.startsWith('-') && seq === null) {
            const parsed = Number(arg)
            if (!Number.isInteger(parsed) || parsed < 1) throw new Error('seq must be a positive integer')
            seq = parsed
            continue
        }
        throw new Error(`Unknown option: ${arg}`)
    }

    if (!sessionId) throw new Error('Missing session ID. Set HAPI_SESSION_ID or pass --session <id>')
    if (seq === null) throw new Error('Missing tool call seq')
    return { sessionId, seq, format, raw }
}

function normalize(message: SessionHistoryMessage): NormalizedMessage | null {
    return normalizeDecryptedMessage({
        id: message.id,
        seq: message.seq,
        createdAt: message.createdAt,
        localId: message.localId ?? null,
        content: message.content
    } as ChatSourceMessage)
}

export function inspectToolCalls(messages: SessionHistoryMessage[], callSeq: number): ToolInspection[] {
    const inspections: ToolInspection[] = []
    const byId = new Map<string, ToolInspection>()

    for (const raw of messages) {
        const message = normalize(raw)
        if (!message || message.role !== 'agent') continue
        const seq = message.seq ?? null
        for (const part of message.content) {
            if (part.type === 'tool-call' && seq === callSeq) {
                const inspection: ToolInspection = {
                    id: part.id,
                    name: part.name,
                    callSeq,
                    resultSeq: null,
                    input: part.input,
                    result: null,
                    isError: null
                }
                inspections.push(inspection)
                byId.set(part.id, inspection)
                continue
            }
            if (part.type === 'tool-result') {
                const inspection = byId.get(part.tool_use_id)
                if (!inspection) continue
                inspection.resultSeq = seq
                inspection.result = part.content
                inspection.isError = part.is_error
            }
        }
    }
    return inspections
}

function stringify(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return '[unserializable]'
    }
}

export function formatToolInspections(inspections: ToolInspection[]): string {
    return inspections.map((inspection) => {
        const seq = inspection.resultSeq === null
            ? String(inspection.callSeq)
            : `${inspection.callSeq}–${inspection.resultSeq}`
        const status = inspection.resultSeq === null
            ? 'pending'
            : inspection.isError
                ? 'failed'
                : 'completed'
        return [
            `Tool: ${inspection.name}`,
            `Seq: ${seq}`,
            `Call ID: ${inspection.id}`,
            `Status: ${status}`,
            '',
            'Input:',
            stringify(inspection.input),
            '',
            'Result:',
            inspection.resultSeq === null ? '[pending]' : stringify(inspection.result)
        ].join('\n')
    }).join('\n\n---\n\n')
}

export function rawInspectionMessages(messages: SessionHistoryMessage[], inspections: ToolInspection[]): SessionHistoryMessage[] {
    const seqs = new Set<number>()
    for (const inspection of inspections) {
        seqs.add(inspection.callSeq)
        if (inspection.resultSeq !== null) seqs.add(inspection.resultSeq)
    }
    return messages.filter(message => message.seq !== null && seqs.has(message.seq))
}
