import type { AttachmentMetadata, DecryptedMessage } from '../schemas'

/** Delivery state of a locally composed message; only the web client sets it. */
export type MessageStatus = 'sending' | 'sent' | 'failed'

/**
 * Wire message as consumed by the chat pipeline. The hub reads stored messages,
 * the web client adds optimistic-send fields; both normalize through the same code.
 */
export type ChatSourceMessage = DecryptedMessage & {
    status?: MessageStatus
    originalText?: string
}

export type UsageData = {
    usage_id?: string
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: string
    /** Current context reported directly by the agent. */
    context_tokens?: number
    /** Cumulative usage for the whole agent thread/session. */
    total_tokens?: number
    total_input_tokens?: number
    total_output_tokens?: number
    total_cached_input_tokens?: number
    total_cache_read_input_tokens?: number
    total_cache_creation_input_tokens?: number
    total_reasoning_output_tokens?: number
    reported_cost_usd?: number
    /** Aggregate for one completed Claude turn; reducers sum these across the session. */
    authoritative_turn_totals?: boolean
}

export type AgentEvent =
    | { type: 'switch'; mode: 'local' | 'remote' }
    | { type: 'message'; message: string }
    | { type: 'title-changed'; title: string }
    | { type: 'limit-reached'; endsAt: number; limitType: string }
    | { type: 'limit-warning'; /** 0–1 ratio (e.g. 0.9 = 90%), integer-precision via CLI pipe format */ utilization: number; endsAt: number; limitType: string }
    | { type: 'ready' }
    | { type: 'api-error'; retryAttempt: number; maxRetries: number; error: unknown }
    | { type: 'turn-duration'; durationMs: number }
    | { type: 'microcompact'; trigger: string; preTokens: number; tokensSaved: number }
    | { type: 'compact'; trigger: string; preTokens: number }
    | ({ type: string } & Record<string, unknown>)

export type ToolResultPermission = {
    date: number
    result: 'approved' | 'denied'
    mode?: string
    allowedTools?: string[]
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
}

export type ToolUse = {
    type: 'tool-call'
    id: string
    name: string
    input: unknown
    description: string | null
    uuid: string
    parentUUID: string | null
}

export type ToolResult = {
    type: 'tool-result'
    tool_use_id: string
    content: unknown
    is_error: boolean
    uuid: string
    parentUUID: string | null
    permissions?: ToolResultPermission
}

/**
 * One tool of a hub-compacted tool group. Carries everything the collapsed and
 * expanded group card renders; the result body is fetched on demand.
 */
export type ToolGroupToolDescriptor = {
    id: string
    name: string
    input: unknown
    description: string | null
    state: 'pending' | 'running' | 'completed' | 'error'
    createdAt: number
    startedAt: number | null
    completedAt: number | null
    /** True when the hub stripped the result body from this descriptor. */
    resultPending: boolean
}

/**
 * A whole run of consecutive tool calls, delivered as one message so page
 * payloads stay small and the run can never be split across pages.
 */
export type ToolGroupContent = {
    type: 'tool-group'
    groupId: string
    firstSeq: number
    lastSeq: number
    tools: ToolGroupToolDescriptor[]
    /** Summed usage of the messages this group replaces. */
    usage?: UsageData
    model?: string
}

export type NormalizedAgentContent =
    | {
        type: 'text'
        text: string
        uuid: string
        parentUUID: string | null
    }
    | {
        type: 'reasoning'
        text: string
        uuid: string
        parentUUID: string | null
    }
    | ToolUse
    | ToolResult
    | ToolGroupContent
    | { type: 'summary'; summary: string }
    | { type: 'sidechain'; uuid: string; prompt: string }

export type NormalizedMessage = ({
    role: 'user'
    content: { type: 'text'; text: string; attachments?: AttachmentMetadata[] }
} | {
    role: 'agent'
    content: NormalizedAgentContent[]
} | {
    role: 'event'
    content: AgentEvent
}) & {
    id: string
    localId: string | null
    createdAt: number
    seq?: number | null
    isSidechain: boolean
    meta?: unknown
    usage?: UsageData
    model?: string
    status?: MessageStatus
    originalText?: string
}

export type ToolPermission = {
    id: string
    status: 'pending' | 'approved' | 'denied' | 'canceled'
    reason?: string
    mode?: string
    allowedTools?: string[]
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    date?: number
    createdAt?: number | null
    completedAt?: number | null
}

export type ChatToolCall = {
    id: string
    name: string
    state: 'pending' | 'running' | 'completed' | 'error'
    input: unknown
    createdAt: number
    startedAt: number | null
    completedAt: number | null
    description: string | null
    result?: unknown
    permission?: ToolPermission
    /** Result body lives on the hub only; open the detail view to fetch it. */
    resultPending?: boolean
    /** Seq range of the compacted tool run this call was delivered in. */
    groupSpan?: { firstSeq: number; lastSeq: number }
}

export type UserTextBlock = {
    kind: 'user-text'
    id: string
    localId: string | null
    createdAt: number
    seq?: number | null
    text: string
    attachments?: AttachmentMetadata[]
    status?: MessageStatus
    originalText?: string
    meta?: unknown
}

export type AgentTextBlock = {
    kind: 'agent-text'
    id: string
    localId: string | null
    createdAt: number
    seq?: number | null
    text: string
    meta?: unknown
}

export type AgentReasoningBlock = {
    kind: 'agent-reasoning'
    id: string
    localId: string | null
    createdAt: number
    seq?: number | null
    text: string
    meta?: unknown
}

export type CliOutputBlock = {
    kind: 'cli-output'
    id: string
    localId: string | null
    createdAt: number
    text: string
    source: 'user' | 'assistant'
    meta?: unknown
}

export type AgentEventBlock = {
    kind: 'agent-event'
    id: string
    createdAt: number
    event: AgentEvent
    meta?: unknown
}

export type ToolCallBlock = {
    kind: 'tool-call'
    id: string
    localId: string | null
    createdAt: number
    tool: ChatToolCall
    children: ChatBlock[]
    meta?: unknown
}

export type ChatBlock = UserTextBlock | AgentTextBlock | AgentReasoningBlock | CliOutputBlock | ToolCallBlock | AgentEventBlock
