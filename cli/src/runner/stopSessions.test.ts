import { beforeEach, describe, expect, it, vi } from 'vitest'
import { killProcessTree } from '@/utils/process'
import { stopTrackedSessions } from './stopSessions'
import type { TrackedSession } from './types'

vi.mock('@/utils/process', () => ({ killProcessTree: vi.fn() }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(killProcessTree).mockResolvedValue(true)
})

describe('stopTrackedSessions', () => {
    it('waits for all matching trees, including externally started sessions', async () => {
        const sessions = new Map<number, TrackedSession>([
            [10, { pid: 10, happySessionId: 's', startedBy: 'runner' }],
            [20, { pid: 20, happySessionId: 's', startedBy: 'terminal' }],
            [30, { pid: 30, happySessionId: 'other', startedBy: 'runner' }]
        ])
        let finish!: (value: boolean) => void
        vi.mocked(killProcessTree).mockImplementation(pid => pid === 10
            ? new Promise(resolve => { finish = resolve })
            : Promise.resolve(true))
        let resolved = false
        const stopped = stopTrackedSessions(sessions, 's').then(result => { resolved = true; return result })
        await Promise.resolve()
        expect(resolved).toBe(false)
        expect(sessions.has(10)).toBe(true)
        finish(true)
        expect(await stopped).toBe(true)
        expect([...sessions.keys()]).toEqual([30])
        expect(killProcessTree).toHaveBeenCalledWith(10)
        expect(killProcessTree).toHaveBeenCalledWith(20)
    })

    it('retains tracking and refuses success if a descendant survives', async () => {
        const sessions = new Map<number, TrackedSession>([[10, { pid: 10, happySessionId: 's', startedBy: 'runner' }]])
        vi.mocked(killProcessTree).mockResolvedValue(false)
        expect(await stopTrackedSessions(sessions, 's')).toBe(false)
        expect(sessions.has(10)).toBe(true)
    })

    it('supports PID fallback without stopping another session', async () => {
        const sessions = new Map<number, TrackedSession>([[10, { pid: 10, happySessionId: 's', startedBy: 'terminal' }]])
        expect(await stopTrackedSessions(sessions, 'missing')).toBe(false)
        expect(await stopTrackedSessions(sessions, 'PID-10')).toBe(true)
    })
})
