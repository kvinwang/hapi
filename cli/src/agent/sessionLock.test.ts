import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireSessionLock } from './sessionLock'

const directories: string[] = []
const releases: Array<() => Promise<void>> = []

afterEach(async () => {
    for (const release of releases.splice(0)) await release()
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('acquireSessionLock', () => {
    it('blocks a second local agent even without any hub connection', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-session-lock-'))
        directories.push(home)
        const release = await acquireSessionLock(home, 'session')
        await expect(acquireSessionLock(home, 'session')).rejects.toThrow('already has a local agent')
        await release()
        releases.push(await acquireSessionLock(home, 'session'))
    }, 20_000)

    it('recovers a stale lock left by a force-killed process', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-session-lock-'))
        directories.push(home)
        const release = await acquireSessionLock(home, 'crashed')
        await release()
        const key = createHash('sha256').update('crashed').digest('hex')
        const file = join(home, 'session-locks', key)
        const module = createRequire(import.meta.url).resolve('proper-lockfile')
        const child = spawn(process.execPath, ['-e', `
            require(${JSON.stringify(module)}).lock(${JSON.stringify(file)}, { realpath: false }).then(() => {
                console.log('locked');
                setInterval(() => {}, 1000);
            });
        `], { stdio: ['ignore', 'pipe', 'ignore'] })
        try {
            await once(child.stdout, 'data')
            const exited = once(child, 'exit')
            child.kill('SIGKILL')
            await exited
            releases.push(await acquireSessionLock(home, 'crashed'))
        } finally {
            child.kill('SIGKILL')
        }
    }, 20_000)

    it('allows different session ids', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-session-lock-'))
        directories.push(home)
        releases.push(await acquireSessionLock(home, 'one'))
        releases.push(await acquireSessionLock(home, 'two'))
    })
})
