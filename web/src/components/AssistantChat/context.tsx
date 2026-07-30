import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import type { UsageData } from '@hapi/protocol/chat'

export type HappyChatContextValue = {
    api: ApiClient | null
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    onForkFromMessage?: (messageSeq: number) => void
    onForkFullHistory?: (messageSeq: number) => void
    maxBlockSeq?: number
    contextWindowTokens?: number | null
    getUsageAtSeq?: (seq: number) => UsageData | null
    staticView: boolean
    trimMode: boolean
    onTrim?: (action: { mode: 'before' | 'after' | 'single'; seq: number }) => void
    mutatePreservingScroll: (mutate: () => void, source?: HTMLElement) => void
}

const HappyChatContext = createContext<HappyChatContextValue | null>(null)

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    return (
        <HappyChatContext.Provider value={props.value}>
            {props.children}
        </HappyChatContext.Provider>
    )
}

export function useHappyChatContext(): HappyChatContextValue {
    const ctx = useContext(HappyChatContext)
    if (!ctx) {
        throw new Error('HappyChatContext is missing')
    }
    return ctx
}
