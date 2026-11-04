import {
    GROUP_GUIDANCE,
    groupMemberId,
    type Group,
    type GroupSender,
    type GroupInbox,
    type GroupContext
} from '@hapi/protocol/groups'
import type { Store } from '../store'
import type { SyncEngine } from './syncEngine'

export class GroupError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 = 400
    ) {
        super(message)
    }
}

export class GroupService {
    private readonly listeners = new Set<() => void>()
    private readonly lastWake = new Map<string, number>()
    private readonly dispatching = new Set<string>()
    private flushing = false
    private readonly contextSnapshots = new Map<string, string>()

    constructor(
        readonly store: Store,
        private readonly engine: SyncEngine,
        private readonly notify: (sessionId: string, snapshot: GroupContext) => void = () => {},
        private readonly notifyWeb: (namespace: string) => void = () => {}
    ) {}

    changed(namespace: string): void {
        this.notifyWeb(namespace)
        for (const listener of this.listeners) listener()
        for (const session of this.engine.getSessions()) {
            if (!session.active || session.namespace !== namespace) continue
            const snapshot = this.contextSnapshot(session.id, namespace)
            if (snapshot.revision !== (this.contextSnapshots.get(session.id) ?? '[]')) {
                this.contextSnapshots.set(session.id, snapshot.revision)
                this.notify(session.id, snapshot)
            }
        }
    }

    actor(sender: GroupSender, namespace: string): string {
        if (sender.kind === 'session' && !this.engine.resolveSessionAccess(sender.sessionId, namespace).ok) {
            throw new GroupError('Sender session does not exist', 404)
        }
        return groupMemberId(sender)
    }

    group(id: string, namespace: string): Group {
        const group = this.store.groups.get(id, namespace)
        if (!group) throw new GroupError('Group not found', 404)
        return group
    }

    member(id: string, namespace: string, sender: GroupSender): Group {
        const group = this.group(id, namespace)
        const memberId = this.actor(sender, namespace)
        if (!this.store.groups.members(id).some(m => m.id === memberId))
            throw new GroupError('Session is not a group member', 403)
        return group
    }

    writable(group: Group): void {
        if (group.archived) throw new GroupError('Group is archived', 409)
    }

    add(id: string, namespace: string, sender: GroupSender): void {
        this.writable(this.group(id, namespace))
        this.actor(sender, namespace)
        this.store.groups.add(id, sender)
        this.changed(namespace)
    }

    members(id: string, namespace: string) {
        this.group(id, namespace)
        return this.store.groups.members(id).map(member => {
            const session = member.kind === 'session' ? this.engine.getSession(member.id) : undefined
            return {
                ...member,
                title: member.kind === 'user' ? 'You' : (session?.metadata?.name ?? member.id),
                summary: session?.metadata?.summary,
                machineId: session?.metadata?.machineId,
                machine: session?.metadata?.host,
                path: session?.metadata?.path,
                status:
                    member.kind === 'user'
                        ? 'user'
                        : !session?.active
                          ? 'inactive'
                          : Object.keys(session.agentState?.requests ?? {}).length
                            ? 'approval'
                            : session.thinking
                              ? 'busy'
                              : 'idle'
            }
        })
    }

    async send(
        id: string,
        namespace: string,
        sender: GroupSender,
        input: {
            text: string
            mentions: string[]
            replyTo?: string
            clientMessageId: string
        }
    ) {
        this.writable(this.member(id, namespace, sender))
        const members = this.store.groups.members(id)
        for (const target of input.mentions) {
            if (target === groupMemberId(sender)) throw new GroupError('Cannot mention yourself')
            if (!members.some(m => m.id === target)) throw new GroupError(`Mention target is not a member: ${target}`)
        }
        const repliedMessage = input.replyTo ? this.store.groups.message(input.replyTo) : undefined
        if (input.replyTo && repliedMessage?.groupId !== id)
            throw new GroupError('Reply target is not in this group')
        const replySessionId = repliedMessage?.sender.kind === 'session' ? repliedMessage.sender.sessionId : undefined
        const mentions = new Set(input.mentions)
        if (replySessionId && replySessionId !== groupMemberId(sender) && members.some(member => member.id === replySessionId)) {
            mentions.add(replySessionId)
        }
        const result = this.store.groups.send(id, sender, { ...input, mentions: [...mentions] })
        if (!result.duplicate) {
            for (const target of result.message.mentions)
                this.store.groups.receipt(result.message.id, target, 'queued', 'busy')
            this.changed(namespace)
            for (const target of result.message.mentions) await this.dispatch(id, namespace, target)
        }
        const message = this.store.groups.message(result.message.id)!
        return {
            message,
            mentions: message.receipts.filter(r => message.mentions.includes(r.memberId))
        }
    }

    private async dispatch(groupId: string, namespace: string, target: string): Promise<void> {
        const key = `${groupId}:${target}`
        if (this.dispatching.has(key)) return
        this.dispatching.add(key)
        try {
            const pending = this.store.groups.pending().filter(p => p.groupId === groupId && p.memberId === target)
            if (!pending.length) return
            const group = this.store.groups.get(groupId, namespace)
            const member = this.store.groups.members(groupId).find(m => m.id === target)
            const session = this.engine.getSession(target)
            const reason =
                !group || group.archived || !member || !session?.active
                    ? 'inactive'
                    : !member.mentionWake
                      ? 'muted'
                      : group.wakeCount >= group.wakeLimit
                        ? 'budget'
                        : null
            if (reason) {
                for (const row of pending) this.store.groups.receipt(row.messageId, target, 'not-woken', reason)
                this.changed(namespace)
                return
            }
            if (
                session!.thinking ||
                Object.keys(session!.agentState?.requests ?? {}).length ||
                Date.now() - (this.lastWake.get(target) ?? 0) < 5_000
            )
                return
            if (!this.store.groups.reserveWake(groupId)) return
            this.lastWake.set(target, Date.now())
            await this.engine.sendMessage(target, {
                text: `Group ${groupId} has new messages for you. Run \`hapi group inbox\`.`,
                sentFrom: 'cli',
                groupNotification: true
            })
            for (const row of pending) this.store.groups.receipt(row.messageId, target, 'woken', null)
            this.changed(namespace)
        } finally {
            this.dispatching.delete(key)
        }
    }

    async flush(): Promise<void> {
        if (this.flushing) return
        this.flushing = true
        try {
            const seen = new Set<string>()
            for (const row of this.store.groups.pending()) {
                const key = `${row.groupId}:${row.memberId}`
                if (seen.has(key)) continue
                seen.add(key)
                await this.dispatch(row.groupId, row.namespace, row.memberId)
            }
        } finally {
            this.flushing = false
        }
    }

    contextSnapshot(sessionId: string, namespace: string): GroupContext {
        const groups = this.store.groups.list(namespace, sessionId).filter(g => !g.archived)
        return {
            context: this.context(sessionId, namespace),
            revision: JSON.stringify(groups.map(g => [g.id, this.store.groups.latestSeq(g.id, sessionId)]))
        }
    }

    context(sessionId: string, namespace: string): string {
        const groups = this.store.groups.list(namespace, sessionId).filter(g => !g.archived)
        if (!groups.length) return ''
        return `${GROUP_GUIDANCE}\nGroup membership:\n${groups.map(g => `- ${g.id}: ${g.name} — ${g.description} — ${this.store.groups.unread(g.id, sessionId)} unread (latest #${this.store.groups.latestSeq(g.id)})`).join('\n')}`
    }

    async inbox(
        namespace: string,
        sender: GroupSender,
        options: {
            groupId?: string
            mentions?: boolean
            limit: number
            wait: number
        },
        signal?: AbortSignal
    ): Promise<GroupInbox> {
        const memberId = this.actor(sender, namespace)
        if (options.groupId) this.member(options.groupId, namespace, sender)
        const read = () => this.store.groups.inbox(namespace, memberId, options)
        const immediate = read()
        if (immediate.messages.length || !options.wait || signal?.aborted) return immediate
        return await new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer)
                this.listeners.delete(check)
                signal?.removeEventListener('abort', finish)
                resolve(read())
            }
            const check = () => {
                if (read().messages.length) finish()
            }
            const timer = setTimeout(finish, options.wait * 1_000)
            this.listeners.add(check)
            signal?.addEventListener('abort', finish, { once: true })
            check()
        })
    }

    consume(namespace: string, sender: GroupSender, ids: string[]): void {
        const memberId = this.actor(sender, namespace)
        for (const id of ids) {
            const message = this.store.groups.message(id)
            if (!message) throw new GroupError('Message not found', 404)
            this.member(message.groupId, namespace, sender)
        }
        this.store.groups.consume(memberId, ids)
        this.changed(namespace)
    }
}
