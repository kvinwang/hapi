import type { AgentState } from '@/types/api'
import type { ChatBlock, NormalizedMessage, UsageData } from '@/chat/types'
import { traceMessages, type TracedMessage } from '@/chat/tracer'
import { dedupeAgentEvents, foldApiErrorEvents } from '@/chat/reducerEvents'
import { collectTitleChanges, collectToolIdsFromMessages, ensureToolBlock, getPermissions } from '@/chat/reducerTools'
import { reduceTimeline } from '@/chat/reducerTimeline'

// Calculate context size from usage data
function calculateContextSize(usage: UsageData): number {
    if (usage.context_tokens !== undefined) return usage.context_tokens
    return (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens
}

export type LatestUsage = {
    inputTokens: number
    outputTokens: number
    cacheCreation: number
    cacheRead: number
    contextSize: number
    timestamp: number
    model?: string
    totalTokens?: number
    totalInputTokens?: number
    totalOutputTokens?: number
    totalCachedInputTokens?: number
    totalCacheReadInputTokens?: number
    totalCacheCreationInputTokens?: number
    totalReasoningOutputTokens?: number
    reportedCostUsd?: number
}

export function reduceChatBlocks(
    normalized: NormalizedMessage[],
    agentState: AgentState | null | undefined
): { blocks: ChatBlock[]; hasReadyEvent: boolean; latestUsage: LatestUsage | null } {
    const permissionsById = getPermissions(agentState)
    const toolIdsInMessages = collectToolIdsFromMessages(normalized)
    const titleChangesByToolUseId = collectTitleChanges(normalized)

    const traced = traceMessages(normalized)
    const groups = new Map<string, TracedMessage[]>()
    const root: TracedMessage[] = []

    for (const msg of traced) {
        if (msg.sidechainId) {
            const existing = groups.get(msg.sidechainId) ?? []
            existing.push(msg)
            groups.set(msg.sidechainId, existing)
        } else {
            root.push(msg)
        }
    }

    const consumedGroupIds = new Set<string>()
    const emittedTitleChangeToolUseIds = new Set<string>()
    const reducerContext = { permissionsById, groups, consumedGroupIds, titleChangesByToolUseId, emittedTitleChangeToolUseIds }
    const rootResult = reduceTimeline(root, reducerContext)
    let hasReadyEvent = rootResult.hasReadyEvent

    // Only create permission-only tool cards when there is no tool call/result in the transcript.
    // Also skip if the permission is older than the oldest message in the current view,
    // to avoid mixing old tool cards with newer messages when paginating.
    const oldestMessageTime = normalized.length > 0
        ? Math.min(...normalized.map(m => m.createdAt))
        : null

    for (const [id, entry] of permissionsById) {
        if (toolIdsInMessages.has(id)) continue
        if (rootResult.toolBlocksById.has(id)) continue

        const createdAt = entry.permission.createdAt ?? Date.now()

        // Skip permissions that are older than the oldest message in the current view.
        // These will be shown when the user loads older messages.
        if (oldestMessageTime !== null && createdAt < oldestMessageTime) {
            continue
        }

        const block = ensureToolBlock(rootResult.blocks, rootResult.toolBlocksById, id, {
            createdAt,
            localId: null,
            name: entry.toolName,
            input: entry.input,
            description: null,
            permission: entry.permission
        })

        if (entry.permission.status === 'approved') {
            block.tool.state = 'completed'
            block.tool.completedAt = entry.permission.completedAt ?? createdAt
            if (block.tool.result === undefined) {
                block.tool.result = 'Approved'
            }
        } else if (entry.permission.status === 'denied' || entry.permission.status === 'canceled') {
            block.tool.state = 'error'
            block.tool.completedAt = entry.permission.completedAt ?? createdAt
            if (block.tool.result === undefined && entry.permission.reason) {
                block.tool.result = { error: entry.permission.reason }
            }
        }
    }

    // Re-sort blocks by createdAt so that permission-only tool cards
    // (which are appended at the end by ensureToolBlock) appear at their
    // correct chronological position among other blocks.
    rootResult.blocks.sort((a, b) => a.createdAt - b.createdAt)

    // Calculate latest usage from messages (find the most recent message with usage data)
    let latestUsage: LatestUsage | null = null
    let summedInput = 0
    let summedOutput = 0
    let summedCacheCreation = 0
    let summedCacheRead = 0
    let hasSummableUsage = false
    let cumulativeHighWater: NonNullable<NormalizedMessage['usage']> | null = null
    let authoritativeReportedCost = 0
    let hasAuthoritativeReportedCost = false
    const summedUsageIds = new Set<string>()
    for (const msg of normalized) {
        if (msg.usage?.total_tokens !== undefined) {
            if (!cumulativeHighWater || msg.usage.total_tokens >= (cumulativeHighWater.total_tokens ?? 0)) {
                cumulativeHighWater = msg.usage
            }
            if (msg.usage.reported_cost_usd !== undefined) {
                authoritativeReportedCost = Math.max(authoritativeReportedCost, msg.usage.reported_cost_usd)
                hasAuthoritativeReportedCost = true
            }
        }
        if (!msg.usage || msg.usage.total_tokens !== undefined) continue
        if (msg.usage.usage_id) {
            if (summedUsageIds.has(msg.usage.usage_id)) continue
            summedUsageIds.add(msg.usage.usage_id)
        }
        hasSummableUsage = true
        summedInput += msg.usage.input_tokens
        summedOutput += msg.usage.output_tokens
        summedCacheCreation += msg.usage.cache_creation_input_tokens ?? 0
        summedCacheRead += msg.usage.cache_read_input_tokens ?? 0
    }
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.usage) {
            const previousContextUsage = msg.usage.total_tokens !== undefined && msg.usage.context_tokens === undefined
                ? normalized.slice(0, i).reverse().find((entry) => entry.usage?.total_tokens === undefined)?.usage
                : undefined
            latestUsage = {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                cacheCreation: msg.usage.cache_creation_input_tokens ?? 0,
                cacheRead: msg.usage.cache_read_input_tokens ?? 0,
                contextSize: previousContextUsage
                    ? calculateContextSize(previousContextUsage)
                    : calculateContextSize(msg.usage),
                timestamp: msg.createdAt,
                model: msg.model,
                totalTokens: msg.usage.total_tokens,
                totalInputTokens: msg.usage.total_input_tokens,
                totalOutputTokens: msg.usage.total_output_tokens,
                totalCachedInputTokens: msg.usage.total_cached_input_tokens,
                totalCacheReadInputTokens: msg.usage.total_cache_read_input_tokens,
                totalCacheCreationInputTokens: msg.usage.total_cache_creation_input_tokens,
                totalReasoningOutputTokens: msg.usage.total_reasoning_output_tokens,
                reportedCostUsd: msg.usage.reported_cost_usd
            }
            if (cumulativeHighWater) {
                latestUsage.totalInputTokens = cumulativeHighWater.total_input_tokens
                latestUsage.totalOutputTokens = cumulativeHighWater.total_output_tokens
                latestUsage.totalCachedInputTokens = cumulativeHighWater.total_cached_input_tokens
                latestUsage.totalCacheReadInputTokens = cumulativeHighWater.total_cache_read_input_tokens
                    ?? cumulativeHighWater.total_cached_input_tokens
                latestUsage.totalCacheCreationInputTokens = cumulativeHighWater.total_cache_creation_input_tokens
                latestUsage.totalReasoningOutputTokens = cumulativeHighWater.total_reasoning_output_tokens
                latestUsage.totalTokens = cumulativeHighWater.total_tokens
                latestUsage.reportedCostUsd = hasAuthoritativeReportedCost ? authoritativeReportedCost : undefined
            }
            if (latestUsage.totalTokens === undefined && hasSummableUsage) {
                latestUsage.totalInputTokens = summedInput + summedCacheCreation + summedCacheRead
                latestUsage.totalOutputTokens = summedOutput
                latestUsage.totalCachedInputTokens = summedCacheCreation + summedCacheRead
                latestUsage.totalTokens = latestUsage.totalInputTokens + latestUsage.totalOutputTokens
            }
            break
        }
    }

    return { blocks: dedupeAgentEvents(foldApiErrorEvents(rootResult.blocks)), hasReadyEvent, latestUsage }
}
