import { logger } from '@/ui/logger'
import { restoreTerminalState } from '@/ui/terminalState'
import { spawnWithAbort } from '@/utils/spawnWithAbort'

export async function piLocal(opts: {
    path: string
    sessionId: string | null
    model?: string
    abort: AbortSignal
}): Promise<void> {
    const args: string[] = []
    if (opts.sessionId) args.push('--session', opts.sessionId)
    if (opts.model && opts.model !== 'auto') args.push('--model', opts.model)
    logger.debug(`[PiLocal] Spawning pi with args: ${JSON.stringify(args)}`)
    process.stdin.pause()
    try {
        await spawnWithAbort({
            command: 'pi', args, cwd: opts.path, env: process.env, signal: opts.abort,
            shell: process.platform === 'win32', logLabel: 'PiLocal', spawnName: 'pi',
            installHint: '@earendil-works/pi-coding-agent', includeCause: true, logExit: true
        })
    } finally {
        process.stdin.resume()
        restoreTerminalState()
    }
}
