import { createContext, useContext } from 'react'
import type { SubagentEntry } from '@hapi/protocol/types'

export type SubagentsContextValue = {
    /** Subagents of the owning agent session, keyed by the spawning tool call id. */
    entries: Record<string, SubagentEntry>
    /** Whether the owning agent is alive; a `running` entry of a dead agent is stale. */
    ownerActive: boolean
    open: (sessionId: string) => void
}

const SubagentsContext = createContext<SubagentsContextValue | null>(null)

export const SubagentsProvider = SubagentsContext.Provider

export function useSubagents(): SubagentsContextValue | null {
    return useContext(SubagentsContext)
}

export function isSubagentRunning(entry: SubagentEntry, ownerActive: boolean): boolean {
    return entry.status === 'running' && ownerActive
}
