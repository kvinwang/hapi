import { logger } from '@/ui/logger'
import { killProcessTree } from '@/utils/process'
import type { TrackedSession } from './types'

export async function stopTrackedSessions(sessions: Map<number, TrackedSession>, sessionId: string): Promise<boolean> {
    const matching = [...sessions.values()].filter(session =>
        session.happySessionId === sessionId || sessionId === `PID-${session.pid}`
    )
    if (matching.length === 0) return false

    const stopped = await Promise.all(matching.map(async session => {
        try {
            if (!await killProcessTree(session.pid)) return false
            sessions.delete(session.pid)
            return true
        } catch (error) {
            logger.debug(`[RUNNER RUN] Failed to stop session ${sessionId} (PID ${session.pid}):`, error)
            return false
        }
    }))
    return stopped.every(Boolean)
}
