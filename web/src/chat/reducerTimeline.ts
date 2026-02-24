import type { ChatBlock, ToolCallBlock, ToolPermission } from '@/chat/types'
import type { TracedMessage } from '@/chat/tracer'
import { createCliOutputBlock, isCliOutputText, mergeCliOutputBlocks } from '@/chat/reducerCliOutput'
import { parseMessageAsEvent } from '@/chat/reducerEvents'
import { ensureToolBlock, extractTitleFromChangeTitleInput, isChangeTitleToolName, type PermissionEntry } from '@/chat/reducerTools'
import { isObject } from '@hapi/protocol'

function scoreToolResultContent(value: unknown, depth: number = 0): number {
    if (depth > 3 || value === null || value === undefined) return 0
    if (typeof value === 'string') return value.trim().length > 0 ? 8 : 0
    if (typeof value === 'number' || typeof value === 'boolean') return 2

    if (Array.isArray(value)) {
        let best = 0
        for (const item of value) {
            best = Math.max(best, scoreToolResultContent(item, depth + 1))
        }
        return best > 0 ? best + 1 : 0
    }

    if (!isObject(value)) return 0

    let score = 1
    const textLike = ['output', 'stdout', 'stderr', 'formatted_output', 'aggregated_output', 'text', 'content', 'message', 'error'] as const
    for (const key of textLike) {
        const raw = value[key]
        if (typeof raw === 'string' && raw.trim().length > 0) {
            score = Math.max(score, 10)
        } else if (raw !== undefined) {
            score = Math.max(score, 2 + scoreToolResultContent(raw, depth + 1))
        }
    }

    if (score < 10) {
        score = Math.max(score, 1 + scoreToolResultContent(value.output_raw, depth + 1))
        score = Math.max(score, 1 + scoreToolResultContent(value.data, depth + 1))
        score = Math.max(score, 1 + scoreToolResultContent(value.result, depth + 1))
    }

    return score
}

export function reduceTimeline(
    messages: TracedMessage[],
    context: {
        permissionsById: Map<string, PermissionEntry>
        groups: Map<string, TracedMessage[]>
        consumedGroupIds: Set<string>
        titleChangesByToolUseId: Map<string, string>
        emittedTitleChangeToolUseIds: Set<string>
    }
): { blocks: ChatBlock[]; toolBlocksById: Map<string, ToolCallBlock>; hasReadyEvent: boolean } {
    const blocks: ChatBlock[] = []
    const toolBlocksById = new Map<string, ToolCallBlock>()
    let hasReadyEvent = false

    for (const msg of messages) {
        if (msg.role === 'event') {
            if (msg.content.type === 'ready') {
                hasReadyEvent = true
                continue
            }
            blocks.push({
                kind: 'agent-event',
                id: msg.id,
                createdAt: msg.createdAt,
                event: msg.content,
                meta: msg.meta
            })
            continue
        }

        const event = parseMessageAsEvent(msg)
        if (event) {
            blocks.push({
                kind: 'agent-event',
                id: msg.id,
                createdAt: msg.createdAt,
                event,
                meta: msg.meta
            })
            continue
        }

        if (msg.role === 'user') {
            if (isCliOutputText(msg.content.text, msg.meta)) {
                blocks.push(createCliOutputBlock({
                    id: msg.id,
                    localId: msg.localId,
                    createdAt: msg.createdAt,
                    text: msg.content.text,
                    source: 'user',
                    meta: msg.meta
                }))
                continue
            }
            blocks.push({
                kind: 'user-text',
                id: msg.id,
                localId: msg.localId,
                createdAt: msg.createdAt,
                seq: msg.seq,
                text: msg.content.text,
                attachments: msg.content.attachments,
                status: msg.status,
                originalText: msg.originalText,
                meta: msg.meta
            })
            continue
        }

        if (msg.role === 'agent') {
            for (let idx = 0; idx < msg.content.length; idx += 1) {
                const c = msg.content[idx]
                if (c.type === 'text') {
                    if (isCliOutputText(c.text, msg.meta)) {
                        blocks.push(createCliOutputBlock({
                            id: `${msg.id}:${idx}`,
                            localId: msg.localId,
                            createdAt: msg.createdAt,
                            text: c.text,
                            source: 'assistant',
                            meta: msg.meta
                        }))
                        continue
                    }
                    blocks.push({
                        kind: 'agent-text',
                        id: `${msg.id}:${idx}`,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        seq: msg.seq,
                        text: c.text,
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'reasoning') {
                    blocks.push({
                        kind: 'agent-reasoning',
                        id: `${msg.id}:${idx}`,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        seq: msg.seq,
                        text: c.text,
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'summary') {
                    blocks.push({
                        kind: 'agent-event',
                        id: `${msg.id}:${idx}`,
                        createdAt: msg.createdAt,
                        event: { type: 'message', message: c.summary },
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'tool-call') {
                    if (isChangeTitleToolName(c.name)) {
                        const title = context.titleChangesByToolUseId.get(c.id) ?? extractTitleFromChangeTitleInput(c.input)
                        if (title && !context.emittedTitleChangeToolUseIds.has(c.id)) {
                            context.emittedTitleChangeToolUseIds.add(c.id)
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                event: { type: 'title-changed', title },
                                meta: msg.meta
                            })
                        }
                        continue
                    }

                    const permission = context.permissionsById.get(c.id)?.permission

                    const block = ensureToolBlock(blocks, toolBlocksById, c.id, {
                        createdAt: msg.createdAt,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: c.name,
                        input: c.input,
                        description: c.description,
                        permission
                    })

                    if (block.tool.state === 'pending') {
                        block.tool.state = 'running'
                        block.tool.startedAt = msg.createdAt
                    }

                    if (c.name === 'Task' && !context.consumedGroupIds.has(msg.id)) {
                        const sidechain = context.groups.get(msg.id) ?? null
                        if (sidechain && sidechain.length > 0) {
                            context.consumedGroupIds.add(msg.id)
                            const child = reduceTimeline(sidechain, context)
                            hasReadyEvent = hasReadyEvent || child.hasReadyEvent
                            block.children = child.blocks
                        }
                    }
                    continue
                }

                if (c.type === 'tool-result') {
                    const title = context.titleChangesByToolUseId.get(c.tool_use_id) ?? null
                    if (title) {
                        if (!context.emittedTitleChangeToolUseIds.has(c.tool_use_id)) {
                            context.emittedTitleChangeToolUseIds.add(c.tool_use_id)
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                event: { type: 'title-changed', title },
                                meta: msg.meta
                            })
                        }
                        continue
                    }

                    const permissionEntry = context.permissionsById.get(c.tool_use_id)
                    const permissionFromResult = c.permissions ? ({
                        id: c.tool_use_id,
                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                        date: c.permissions.date,
                        mode: c.permissions.mode,
                        allowedTools: c.permissions.allowedTools,
                        decision: c.permissions.decision
                    } satisfies ToolPermission) : undefined

                    const permission = (() => {
                        if (permissionFromResult && permissionEntry?.permission) {
                            return {
                                ...permissionEntry.permission,
                                ...permissionFromResult,
                                allowedTools: permissionFromResult.allowedTools ?? permissionEntry.permission.allowedTools,
                                decision: permissionFromResult.decision ?? permissionEntry.permission.decision
                            } satisfies ToolPermission
                        }
                        return permissionFromResult ?? permissionEntry?.permission
                    })()

                    const block = ensureToolBlock(blocks, toolBlocksById, c.tool_use_id, {
                        createdAt: msg.createdAt,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: permissionEntry?.toolName ?? 'Tool',
                        input: permissionEntry?.input ?? null,
                        description: null,
                        permission
                    })

                    const previousResultScore = scoreToolResultContent(block.tool.result)
                    const incomingResultScore = scoreToolResultContent(c.content)
                    if (incomingResultScore >= previousResultScore) {
                        block.tool.result = c.content
                    }
                    block.tool.completedAt = msg.createdAt
                    block.tool.state = c.is_error ? 'error' : 'completed'
                    continue
                }

                if (c.type === 'sidechain') {
                    blocks.push({
                        kind: 'user-text',
                        id: `${msg.id}:${idx}`,
                        localId: null,
                        createdAt: msg.createdAt,
                        text: c.prompt
                    })
                }
            }
        }
    }

    return { blocks: mergeCliOutputBlocks(blocks), toolBlocksById, hasReadyEvent }
}
