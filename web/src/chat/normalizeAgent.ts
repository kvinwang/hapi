import type { AgentEvent, NormalizedAgentContent, NormalizedMessage, ToolResultPermission } from '@/chat/types'
import { asNumber, asString, isObject } from '@hapi/protocol'
import { isClaudeChatVisibleMessage } from '@hapi/protocol/messages'

function normalizeCodexUsage(data: Record<string, unknown>): NormalizedMessage['usage'] | undefined {
    // Nested usage object or flat fields (type: 'usage')
    const source = isObject(data.usage) ? data.usage as Record<string, unknown> : data
    const inputTokens = asNumber(source.input_tokens ?? source.inputTokens)
    const outputTokens = asNumber(source.output_tokens ?? source.outputTokens)
    if (inputTokens === null || outputTokens === null) {
        return undefined
    }
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: asNumber(source.cache_creation_input_tokens ?? source.cacheCreationTokens) ?? undefined,
        cache_read_input_tokens: asNumber(source.cache_read_input_tokens ?? source.cacheReadTokens) ?? undefined,
        service_tier: asString(source.service_tier) ?? undefined
    }
}

function pickTokenBucket(value: unknown): Record<string, unknown> | null {
    return isObject(value) ? value : null
}

function normalizeCodexTokenCount(data: Record<string, unknown>): NormalizedMessage['usage'] | undefined {
    const info = isObject(data.info) ? data.info as Record<string, unknown> : data
    // Codex app-server / MCP shapes vary across versions (snake + camel).
    const candidates = [
        pickTokenBucket(info.last_token_usage),
        pickTokenBucket(info.lastTokenUsage),
        pickTokenBucket(info.total_token_usage),
        pickTokenBucket(info.totalTokenUsage),
        pickTokenBucket(info.token_usage),
        pickTokenBucket(info.tokenUsage),
        info
    ].filter((entry): entry is Record<string, unknown> => entry !== null)

    for (const source of candidates) {
        const inputTokens = asNumber(
            source.input_tokens
            ?? source.inputTokens
            ?? source.total_input_tokens
            ?? source.totalInputTokens
            ?? source.total_tokens
            ?? source.totalTokens
        )
        const outputTokens = asNumber(
            source.output_tokens
            ?? source.outputTokens
            ?? source.total_output_tokens
            ?? source.totalOutputTokens
        ) ?? 0
        if (inputTokens === null) {
            continue
        }
        return {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: asNumber(
                source.cached_input_tokens
                ?? source.cachedInputTokens
                ?? source.cache_read_input_tokens
                ?? source.cacheReadInputTokens
            ) ?? undefined,
            cache_creation_input_tokens: asNumber(
                source.cache_creation_input_tokens
                ?? source.cacheCreationInputTokens
            ) ?? undefined
        }
    }

    // Fallback: some payloads only report aggregate usage at the root.
    const rootTotal = asNumber(info.total_tokens ?? info.totalTokens ?? info.used_tokens ?? info.usedTokens)
    if (rootTotal !== null) {
        return { input_tokens: rootTotal, output_tokens: 0 }
    }
    return undefined
}

function normalizeToolResultPermissions(value: unknown): ToolResultPermission | undefined {
    if (!isObject(value)) return undefined
    const date = asNumber(value.date)
    const result = value.result
    if (date === null) return undefined
    if (result !== 'approved' && result !== 'denied') return undefined

    const mode = asString(value.mode) ?? undefined
    const allowedTools = Array.isArray(value.allowedTools)
        ? value.allowedTools.filter((tool) => typeof tool === 'string')
        : undefined
    const decision = value.decision
    const normalizedDecision = decision === 'approved' || decision === 'approved_for_session' || decision === 'denied' || decision === 'abort'
        ? decision
        : undefined

    return {
        date,
        result,
        mode,
        allowedTools,
        decision: normalizedDecision
    }
}

function normalizeAgentEvent(value: unknown): AgentEvent | null {
    if (!isObject(value) || typeof value.type !== 'string') return null
    return value as AgentEvent
}

function isCodexToolResultError(output: unknown): boolean {
    if (!isObject(output)) return false

    const explicitError = output.error
    if (typeof explicitError === 'string' && explicitError.trim().length > 0) return true

    const status = asString(output.status)?.toLowerCase()
    if (status === 'failed' || status === 'error') return true

    const exitCode = asNumber(output.exit_code ?? output.exitCode)
    if (exitCode !== null && exitCode !== 0) return true

    return false
}

function normalizeAssistantOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown
): NormalizedMessage | null {
    const uuid = asString(data.uuid) ?? messageId
    const parentUUID = asString(data.parentUuid) ?? null
    const isSidechain = Boolean(data.isSidechain)

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const modelContent = message.content
    const blocks: NormalizedAgentContent[] = []

    if (typeof modelContent === 'string') {
        blocks.push({ type: 'text', text: modelContent, uuid, parentUUID })
    } else if (Array.isArray(modelContent)) {
        for (const block of modelContent) {
            if (!isObject(block) || typeof block.type !== 'string') continue
            if (block.type === 'text' && typeof block.text === 'string') {
                blocks.push({ type: 'text', text: block.text, uuid, parentUUID })
                continue
            }
            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                blocks.push({ type: 'reasoning', text: block.thinking, uuid, parentUUID })
                continue
            }
            if (block.type === 'tool_use' && typeof block.id === 'string') {
                const name = asString(block.name) ?? 'Tool'
                const input = 'input' in block ? (block as Record<string, unknown>).input : undefined
                const description = isObject(input) && typeof input.description === 'string' ? input.description : null
                blocks.push({ type: 'tool-call', id: block.id, name, input, description, uuid, parentUUID })
            }
        }
    }

    const usage = isObject(message.usage) ? (message.usage as Record<string, unknown>) : null
    const inputTokens = usage ? asNumber(usage.input_tokens) : null
    const outputTokens = usage ? asNumber(usage.output_tokens) : null
    const messageModel = asString(message.model) ?? undefined

    return {
        id: messageId,
        localId,
        createdAt,
        role: 'agent',
        isSidechain,
        content: blocks,
        meta,
        usage: inputTokens !== null && outputTokens !== null ? {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: asNumber(usage?.cache_creation_input_tokens) ?? undefined,
            cache_read_input_tokens: asNumber(usage?.cache_read_input_tokens) ?? undefined,
            service_tier: asString(usage?.service_tier) ?? undefined
        } : undefined,
        model: messageModel
    }
}

function normalizeUserOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown
): NormalizedMessage | null {
    const uuid = asString(data.uuid) ?? messageId
    const parentUUID = asString(data.parentUuid) ?? null
    const isSidechain = Boolean(data.isSidechain)

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const messageContent = message.content

    if (isSidechain && typeof messageContent === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'agent',
            isSidechain: true,
            content: [{ type: 'sidechain', uuid, prompt: messageContent }]
        }
    }

    // Handle system-injected messages that arrive as type:'user' through
    // the agent output path. Real user text goes through normalizeUserRecord.
    if (typeof messageContent === 'string') {
        // Convert <task-notification> to a visible event
        const trimmed = messageContent.trimStart()
        if (trimmed.startsWith('<task-notification>')) {
            const summary = trimmed.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
            if (summary) {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: { type: 'message', message: summary },
                    isSidechain: false,
                    meta
                }
            }
        }

        // All other string-content user messages in this path are
        // system-injected (subagent prompts, system reminders, etc.).
        // Treat as sidechain so the tracer can match it to a parent Task
        // tool call; unmatched ones are harmlessly skipped by the reducer.
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'agent',
            isSidechain: true,
            content: [{ type: 'sidechain', uuid, prompt: messageContent }]
        }
    }

    const blocks: NormalizedAgentContent[] = []

    if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
            if (!isObject(block) || typeof block.type !== 'string') continue
            if (block.type === 'text' && typeof block.text === 'string') {
                blocks.push({ type: 'text', text: block.text, uuid, parentUUID })
                continue
            }
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const isError = Boolean(block.is_error)
                const rawContent = 'content' in block ? (block as Record<string, unknown>).content : undefined
                const embeddedToolUseResult = 'toolUseResult' in data ? (data as Record<string, unknown>).toolUseResult : null

                const permissions = normalizeToolResultPermissions(block.permissions)

                blocks.push({
                    type: 'tool-result',
                    tool_use_id: block.tool_use_id,
                    content: embeddedToolUseResult ?? rawContent,
                    is_error: isError,
                    uuid,
                    parentUUID,
                    permissions
                })
            }
        }
    }

    return {
        id: messageId,
        localId,
        createdAt,
        role: 'agent',
        isSidechain,
        content: blocks,
        meta
    }
}

export function isSkippableAgentContent(content: unknown): boolean {
    if (!isObject(content) || content.type !== 'output') return false
    const data = isObject(content.data) ? content.data : null
    if (!data) return false
    if (Boolean(data.isMeta) || Boolean(data.isCompactSummary)) return true
    return !isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })
}

export function isCodexContent(content: unknown): boolean {
    return isObject(content) && content.type === 'codex'
}

export function normalizeAgentRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown
): NormalizedMessage | null {
    if (!isObject(content) || typeof content.type !== 'string') return null

    if (content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (!data || typeof data.type !== 'string') return null

        // Skip meta/compact-summary messages (parity with hapi-app)
        if (data.isMeta) return null
        if (data.isCompactSummary) return null
        if (!isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })) return null

        if (data.type === 'assistant') {
            return normalizeAssistantOutput(messageId, localId, createdAt, data, meta)
        }
        if (data.type === 'user') {
            return normalizeUserOutput(messageId, localId, createdAt, data, meta)
        }
        if (data.type === 'summary' && typeof data.summary === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'summary', summary: data.summary }],
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'api_error') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'api-error',
                    retryAttempt: asNumber(data.retryAttempt) ?? 0,
                    maxRetries: asNumber(data.maxRetries) ?? 0,
                    error: data.error
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'turn_duration') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'turn-duration',
                    durationMs: asNumber(data.durationMs) ?? 0
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'microcompact_boundary') {
            const metadata = isObject(data.microcompactMetadata) ? data.microcompactMetadata : null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'microcompact',
                    trigger: asString(metadata?.trigger) ?? 'auto',
                    preTokens: asNumber(metadata?.preTokens) ?? 0,
                    tokensSaved: asNumber(metadata?.tokensSaved) ?? 0
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'compact_boundary') {
            const metadata = isObject(data.compactMetadata) ? data.compactMetadata : null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'compact',
                    trigger: asString(metadata?.trigger) ?? 'auto',
                    preTokens: asNumber(metadata?.preTokens) ?? 0
                },
                isSidechain: false,
                meta
            }
        }
        return null
    }

    if (content.type === 'event') {
        const event = normalizeAgentEvent(content.data)
        if (!event) return null
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'event',
            content: event,
            isSidechain: false,
            meta
        }
    }

    if (content.type === 'codex') {
        const data = isObject(content.data) ? content.data : null
        if (!data || typeof data.type !== 'string') return null

        if (data.type === 'message' && typeof data.message === 'string') {
            const usage = normalizeCodexUsage(data)
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: data.message, uuid: messageId, parentUUID: null }],
                meta,
                usage,
                model: asString(data.model) ?? undefined
            }
        }

        // Token/usage updates from ACP agents (e.g. Grok prompt `_meta`) and Codex token_count.
        if (data.type === 'usage' || data.type === 'token_count') {
            const usage = data.type === 'token_count'
                ? normalizeCodexTokenCount(data)
                : normalizeCodexUsage(data)
            if (!usage) {
                return null
            }
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                // Empty content: used only to feed the context/usage status bar.
                content: [],
                meta,
                usage,
                model: asString(data.model) ?? undefined
            }
        }

        if (data.type === 'reasoning' && typeof data.message === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'reasoning', text: data.message, uuid: messageId, parentUUID: null }],
                meta
            }
        }

        if (data.type === 'tool-call' && typeof data.callId === 'string') {
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: data.callId,
                    name: asString(data.name) ?? 'unknown',
                    input: data.input,
                    description: null,
                    uuid,
                    parentUUID: null
                }],
                meta
            }
        }

        if (data.type === 'tool-call-result' && typeof data.callId === 'string') {
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: data.callId,
                    content: data.output,
                    is_error: isCodexToolResultError(data.output),
                    uuid,
                    parentUUID: null
                }],
                meta
            }
        }
    }

    return null
}
