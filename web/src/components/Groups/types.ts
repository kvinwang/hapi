import type { GroupMember } from '@hapi/protocol/groups'

export type Member = GroupMember & {
    title?: string
    summary?: { text: string }
    machine?: string
    path?: string
    status: string
}

export const memberName = (member: Member): string =>
    member.title ?? (member.kind === 'user' ? 'You' : member.id.slice(0, 8))
export const groupButton =
    'rounded-lg px-3 py-2 text-sm hover:bg-[var(--app-subtle-bg)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
export const groupInput =
    'w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-3 outline-none focus:border-[var(--app-link)]'
