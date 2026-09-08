import { describe, expect, it } from 'vitest'
import { mapCodexEffort } from './codexEffort'
import { buildTurnStartParams } from './appServerConfig'

describe('Codex effort passthrough', () => {
    it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'auto', 'future-level'])(
        'passes %s through to the agent without downgrading it', (effort) => {
            const mapped = mapCodexEffort(effort)
            expect(mapped).toBe(effort)
            expect(buildTurnStartParams({
                threadId: 'thread', message: 'hello', mode: { permissionMode: 'default', effort: mapped }
            }).effort).toBe(effort)
        }
    )

    it('leaves the effort override unset for Default', () => {
        expect(mapCodexEffort('default')).toBeUndefined()
        expect(mapCodexEffort('')).toBeUndefined()
    })
})
