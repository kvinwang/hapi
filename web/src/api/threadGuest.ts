import type { ThreadGuestAuth, ThreadGuestView, ThreadInbox, ThreadMessage } from '@hapi/protocol/threads'

export class ThreadGuestError extends Error {
    constructor(message: string, readonly status: number) {
        super(message)
    }
}

/** Bearer-only client for one thread guest grant; it never sends the owner's cookies. */
export class ThreadGuestClient {
    private token: string | null = null

    constructor(private readonly baseUrl: string, readonly grantId: string, private readonly code: string) {}

    static guideUrl(baseUrl: string, grantId: string): string {
        return `${baseUrl}/api/thread-guest/agent.md?grant=${encodeURIComponent(grantId)}`
    }

    async login(): Promise<ThreadGuestAuth> {
        const auth = await this.fetch<ThreadGuestAuth>('/auth', { method: 'POST', body: JSON.stringify({ grantId: this.grantId, code: this.code }) })
        this.token = auth.token
        return auth
    }

    view(): Promise<ThreadGuestView> {
        return this.request('/thread')
    }

    history(before?: number): Promise<ThreadInbox> {
        return this.request(`/history?limit=50${before ? `&before=${before}` : ''}`)
    }

    send(input: { text: string; mentions: string[]; replyTo?: string; clientMessageId: string }): Promise<{ message: ThreadMessage; wake: 'none' | 'requested' | 'budget' }> {
        return this.request('/send', { method: 'POST', body: JSON.stringify(input) })
    }

    private async request<T>(path: string, init?: RequestInit): Promise<T> {
        if (!this.token) await this.login()
        try {
            return await this.fetch<T>(path, init)
        } catch (error) {
            if (!(error instanceof ThreadGuestError) || error.status !== 401) throw error
            await this.login()
            return await this.fetch<T>(path, init)
        }
    }

    private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
        const headers = new Headers(init?.headers)
        if (init?.body !== undefined) headers.set('content-type', 'application/json')
        if (this.token && path !== '/auth') headers.set('authorization', `Bearer ${this.token}`)
        const response = await fetch(`${this.baseUrl}/api/thread-guest${path}`, { ...init, headers, credentials: 'omit', cache: 'no-store' })
        if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: string } | null
            throw new ThreadGuestError(body?.error ?? `HTTP ${response.status}`, response.status)
        }
        return await response.json() as T
    }
}
