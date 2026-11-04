import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'

export async function acquireSessionLock(home: string, sessionId: string): Promise<() => Promise<void>> {
    const directory = join(home, 'session-locks')
    await mkdir(directory, { recursive: true })
    const key = createHash('sha256').update(sessionId).digest('hex')
    try {
        // Allow the previous owner's heartbeat to expire after forced termination.
        return await lock(join(directory, key), {
            realpath: false,
            retries: { retries: 12, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 }
        })
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
            throw new Error('This session already has a local agent. Stop the existing agent before reviving it.')
        }
        throw error
    }
}
