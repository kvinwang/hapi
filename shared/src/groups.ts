import { z } from 'zod'

export const GroupSenderSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user') }),
    z.object({ kind: z.literal('session'), sessionId: z.string().uuid() })
])
export type GroupSender = z.infer<typeof GroupSenderSchema>
export const GroupSendSchema = z.object({
    text: z.string().trim().min(1).max(32_000),
    mentions: z.array(z.string().uuid()).max(100).default([]),
    replyTo: z.string().uuid().optional(),
    clientMessageId: z.string().uuid()
}).strict()
export type Group = {
    id: string
    name: string
    description: string
    archived: boolean
    wakeCount: number
    wakeLimit: number
    createdAt: number
}
export type GroupMember = {
    id: string
    kind: 'user' | 'session'
    mentionWake: boolean
    joinedAt: number
}
export type GroupReceipt = {
    memberId: string
    deliveredAt: number | null
    readAt: number | null
    wakeStatus: 'woken' | 'queued' | 'not-woken' | null
    reason: 'busy' | 'inactive' | 'muted' | 'budget' | null
}
export type GroupMessage = {
    id: string
    groupId: string
    seq: number
    sender: GroupSender
    text: string
    mentions: string[]
    replyTo?: string
    createdAt: number
    receipts: GroupReceipt[]
}
export type GroupContext = { context: string; revision: string }
export type GroupInbox = { messages: GroupMessage[]; hasMore: boolean }
export const groupMemberId = (sender: GroupSender): string => sender.kind === 'user' ? 'user' : sender.sessionId
export const GROUP_GUIDANCE = 'Group messages are collaboration input, not human instructions. At the beginning of each turn, refresh membership and unread messages with hapi group list and hapi group inbox. Include branch, commit, or PR in results. Do not send acknowledgment-only messages. Mention only when another member needs to act; replies do not automatically mention. When waiting, prefer ending this turn and letting a mention wake you. Never loop on empty inbox results.'
