import {
    THREAD_GUIDANCE,
    threadMemberId,
    type Thread,
    type ThreadSender,
    type ThreadInbox,
    type ThreadContext
} from '@hapi/protocol/threads'
import type { Store } from '../store'
import type { SyncEngine } from './syncEngine'

export class ThreadError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 = 400
    ) {
        super(message)
    }
}

export class ThreadService {
    private readonly listeners = new Set<() => void>()
    private readonly lastWake = new Map<string, number>()
    private readonly dispatching = new Set<string>()
    private flushing = false
    private readonly contextSnapshots = new Map<string, string>()

    constructor(
        readonly store: Store,
        private readonly engine: SyncEngine,
        private readonly notify: (sessionId: string, snapshot: ThreadContext) => void = () => {},
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

    actor(sender: ThreadSender, namespace: string): string {
        if (sender.kind === 'session' && !this.engine.resolveSessionAccess(sender.sessionId, namespace).ok) {
            throw new ThreadError('Sender session does not exist', 404)
        }
        return threadMemberId(sender)
    }

    thread(id: string, namespace: string): Thread {
        const thread = this.store.threads.get(id, namespace)
        if (!thread) throw new ThreadError('Thread not found', 404)
        return thread
    }

    member(id: string, namespace: string, sender: ThreadSender): Thread {
        const thread = this.thread(id, namespace)
        const memberId = this.actor(sender, namespace)
        if (!this.store.threads.members(id).some(m => m.id === memberId))
            throw new ThreadError('Session is not a thread member', 403)
        return thread
    }

    writable(thread: Thread): void {
        if (thread.archived) throw new ThreadError('Thread is archived', 409)
    }

    add(id: string, namespace: string, sender: ThreadSender): void {
        this.writable(this.thread(id, namespace))
        this.actor(sender, namespace)
        this.store.threads.add(id, sender)
        this.changed(namespace)
    }

    members(id: string, namespace: string) {
        this.thread(id, namespace)
        return this.store.threads.members(id).map(member => {
            const session = member.kind === 'session' ? this.engine.getSession(member.id) : undefined
            return {
                ...member,
                title: member.kind === 'user' ? 'You' : (session?.metadata?.name || session?.metadata?.summary?.text || session?.metadata?.path || member.id),
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
        sender: ThreadSender,
        input: {
            text: string
            mentions: string[]
            replyTo?: string
            clientMessageId: string
        }
    ) {
        this.writable(this.member(id, namespace, sender))
        const members = this.store.threads.members(id)
        for (const target of input.mentions) {
            if (target === threadMemberId(sender)) throw new ThreadError('Cannot mention yourself')
            if (!members.some(m => m.id === target)) throw new ThreadError(`Mention target is not a member: ${target}`)
        }
        const repliedMessage = input.replyTo ? this.store.threads.message(input.replyTo) : undefined
        if (input.replyTo && repliedMessage?.threadId !== id)
            throw new ThreadError('Reply target is not in this thread')
        const replySessionId = repliedMessage?.sender.kind === 'session' ? repliedMessage.sender.sessionId : undefined
        const mentions = new Set(input.mentions)
        const sessions = members.filter(member => member.kind === 'session')
        if (sessions.length === 1 && sessions[0].id !== threadMemberId(sender)) {
            mentions.add(sessions[0].id)
        }
        if (replySessionId && replySessionId !== threadMemberId(sender) && members.some(member => member.id === replySessionId)) {
            mentions.add(replySessionId)
        }
        const result = this.store.threads.send(id, sender, { ...input, mentions: [...mentions] })
        if (!result.duplicate) {
            for (const target of result.message.mentions)
                this.store.threads.receipt(result.message.id, target, 'queued', 'busy')
            this.changed(namespace)
            for (const target of result.message.mentions) await this.dispatch(id, namespace, target)
        }
        const message = this.store.threads.message(result.message.id)!
        return {
            message,
            mentions: message.receipts.filter(r => message.mentions.includes(r.memberId))
        }
    }

    private async dispatch(threadId: string, namespace: string, target: string): Promise<void> {
        const key = `${threadId}:${target}`
        if (this.dispatching.has(key)) return
        this.dispatching.add(key)
        try {
            const pending = this.store.threads.pending().filter(p => p.threadId === threadId && p.memberId === target)
            if (!pending.length) return
            const thread = this.store.threads.get(threadId, namespace)
            const member = this.store.threads.members(threadId).find(m => m.id === target)
            const session = this.engine.getSession(target)
            const reason =
                !thread || thread.archived || !member || !session?.active
                    ? 'inactive'
                    : !member.mentionWake
                      ? 'muted'
                      : thread.wakeCount >= thread.wakeLimit
                        ? 'budget'
                        : null
            if (reason) {
                for (const row of pending) this.store.threads.receipt(row.messageId, target, 'not-woken', reason)
                this.changed(namespace)
                return
            }
            if (
                session!.thinking ||
                Object.keys(session!.agentState?.requests ?? {}).length ||
                Date.now() - (this.lastWake.get(target) ?? 0) < 5_000
            )
                return
            if (!this.store.threads.reserveWake(threadId)) return
            this.lastWake.set(target, Date.now())
            await this.engine.sendMessage(target, {
                text: `Thread ${threadId} has new messages for you. Run \`hapi thread inbox\`.`,
                sentFrom: 'cli',
                threadNotification: true
            })
            for (const row of pending) this.store.threads.receipt(row.messageId, target, 'woken', null)
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
            for (const row of this.store.threads.pending()) {
                const key = `${row.threadId}:${row.memberId}`
                if (seen.has(key)) continue
                seen.add(key)
                await this.dispatch(row.threadId, row.namespace, row.memberId)
            }
        } finally {
            this.flushing = false
        }
    }

    contextSnapshot(sessionId: string, namespace: string): ThreadContext {
        const threads = this.store.threads.list(namespace, sessionId).filter(g => !g.archived)
        return {
            context: this.context(sessionId, namespace),
            revision: JSON.stringify(threads.map(g => [g.id, this.store.threads.latestSeq(g.id, sessionId)]))
        }
    }

    context(sessionId: string, namespace: string): string {
        const threads = this.store.threads.list(namespace, sessionId).filter(g => !g.archived)
        if (!threads.length) return ''
        return `${THREAD_GUIDANCE}\nThread membership:\n${threads.map(g => `- ${g.id}: ${g.name} — ${g.description} — ${this.store.threads.unread(g.id, sessionId)} unread (latest #${this.store.threads.latestSeq(g.id)})`).join('\n')}`
    }

    async inbox(
        namespace: string,
        sender: ThreadSender,
        options: {
            threadId?: string
            mentions?: boolean
            limit: number
            wait: number
        },
        signal?: AbortSignal
    ): Promise<ThreadInbox> {
        const memberId = this.actor(sender, namespace)
        if (options.threadId) this.member(options.threadId, namespace, sender)
        const read = () => this.store.threads.inbox(namespace, memberId, options)
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

    consume(namespace: string, sender: ThreadSender, ids: string[]): void {
        const memberId = this.actor(sender, namespace)
        for (const id of ids) {
            const message = this.store.threads.message(id)
            if (!message) throw new ThreadError('Message not found', 404)
            this.member(message.threadId, namespace, sender)
        }
        this.store.threads.consume(memberId, ids)
        this.changed(namespace)
    }
}
