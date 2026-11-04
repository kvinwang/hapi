import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { isProcessAlive, killProcessTree } from './process'

it.skipIf(process.platform === 'win32')('waits for an entire process tree, escalating ignored SIGTERM', async () => {
    const childCode = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"
    const parent = spawn(process.execPath, ['-e', `
        process.on('SIGTERM', () => {});
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}]);
        child.stdout.once('data', () => console.log(child.pid));
        setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'ignore'] })
    const exited = once(parent, 'exit')
    try {
        const childPid = await new Promise<number>(resolve => parent.stdout.once('data', (data: Buffer) => resolve(Number(data.toString().trim()))))
        expect(Number.isInteger(childPid)).toBe(true)
        expect(await killProcessTree(parent.pid!)).toBe(true)
        await exited
        expect(isProcessAlive(parent.pid!)).toBe(false)
        expect(isProcessAlive(childPid)).toBe(false)
    } finally {
        if (parent.pid && isProcessAlive(parent.pid)) await killProcessTree(parent.pid, true)
    }
}, 10_000)
