import type { Metadata } from './types'

/** Metadata for a new child session: inherits the parent's workspace, drops its agent, model and lifecycle state. */
export function childSessionMetadata(parent: Metadata, overrides: Partial<Metadata>): Metadata {
    return {
        ...parent,
        claudeSessionId: undefined,
        codexSessionId: undefined,
        geminiSessionId: undefined,
        opencodeSessionId: undefined,
        cursorSessionId: undefined,
        grokSessionId: undefined,
        piSessionId: undefined,
        hostPid: undefined,
        lifecycleState: undefined,
        lifecycleStateSince: undefined,
        archivedBy: undefined,
        archiveReason: undefined,
        startedFromRunner: undefined,
        startedBy: undefined,
        subagents: undefined,
        subagent: undefined,
        resolvedModel: undefined,
        resolvedModelProvider: undefined,
        resolvedModelAt: undefined,
        ...overrides
    }
}
