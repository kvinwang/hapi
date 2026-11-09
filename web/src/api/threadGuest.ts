import type { ThreadGuestAuth, ThreadGuestView, ThreadInbox, ThreadMessage } from '@hapi/protocol/threads'

export class ThreadGuestError extends Error {
    constructor(message: string, readonly status: number) {
        super(message)
    }
}

/** Bearer-only client for one thread guest grant; it never sends the owner's cookies. */
export class ThreadGuestClient {
    constructor(private readonly baseUrl: string, readonly grantId: string, private readonly token: string) {}

    static guideUrl(baseUrl: string, grantId: string): string {
        return `${baseUrl}/api/thread-guest/agent.md?grant=${encodeURIComponent(grantId)}`
    }

    /** Spends the single-use code; the returned token is the guest's only credential from then on. */
    static redeem(baseUrl: string, grantId: string, code: string): Promise<ThreadGuestAuth> {
        return request(baseUrl, '/auth', null, { method: 'POST', body: JSON.stringify({ grantId, code }) })
    }

    view(): Promise<ThreadGuestView> {
        return request(this.baseUrl, '/thread', this.token)
    }

    history(before?: number): Promise<ThreadInbox> {
        return request(this.baseUrl, `/history?limit=50${before ? `&before=${before}` : ''}`, this.token)
    }

    edit(messageId: string, text: string): Promise<{ message: ThreadMessage }> {
        return request(this.baseUrl, `/messages/${encodeURIComponent(messageId)}/edit`, this.token, { method: 'POST', body: JSON.stringify({ text }) })
    }

    recall(messageId: string): Promise<{ message: ThreadMessage }> {
        return request(this.baseUrl, `/messages/${encodeURIComponent(messageId)}/recall`, this.token, { method: 'POST' })
    }

    send(input: { text: string; mentions: string[]; replyTo?: string; clientMessageId: string }): Promise<{ message: ThreadMessage; wake: 'none' | 'requested' | 'budget' }> {
        return request(this.baseUrl, '/send', this.token, { method: 'POST', body: JSON.stringify(input) })
    }
}

async function request<T>(baseUrl: string, path: string, token: string | null, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    if (init?.body !== undefined) headers.set('content-type', 'application/json')
    if (token) headers.set('authorization', `Bearer ${token}`)
    const response = await fetch(`${baseUrl}/api/thread-guest${path}`, { ...init, headers, credentials: 'omit', cache: 'no-store' })
    if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        throw new ThreadGuestError(body?.error ?? `HTTP ${response.status}`, response.status)
    }
    return await response.json() as T
}
