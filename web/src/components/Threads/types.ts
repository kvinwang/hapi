import type { ThreadMember } from '@hapi/protocol/threads'

export type Member = ThreadMember & {
    title?: string
    summary?: { text: string }
    machine?: string
    path?: string
    status: string
}

export const memberName = (member: Member): string =>
    member.title || member.summary?.text || member.path || (member.kind === 'user' ? 'You' : member.id.slice(0, 8))
export const threadButton =
    'rounded-lg px-3 py-2 text-sm hover:bg-[var(--app-subtle-bg)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
export const threadInput =
    'w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-3 outline-none focus:border-[var(--app-link)]'
