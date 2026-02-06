import { execFileSync } from 'node:child_process'
import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { getHappyCliCommand } from '@/utils/spawnHappyCLI'
import type { CommandDefinition } from './types'

/**
 * hapi scp — wrapper around scp that auto-injects ProxyCommand
 *
 * Usage mirrors scp:
 *   hapi scp localfile user@hostname:remotepath
 *   hapi scp user@hostname:remotepath localfile
 *   hapi scp -r user@hostname:dir/ localdir/
 *   hapi scp -P 2222 file user@hostname:path
 */

function buildProxyCommand(host: string, port: number): string {
    const { command, args } = getHappyCliCommand(['connect', host, String(port)])
    const parts = [command, ...args].map(p => p.includes(' ') ? `"${p}"` : p)
    return parts.join(' ')
}

// SCP options that take a mandatory argument
const SCP_OPTIONS_WITH_ARG = new Set([
    '-c', '-F', '-i', '-J', '-l', '-o', '-S'
])

function parseArgs(args: string[]): { scpPort: number; host: string; scpArgs: string[] } {
    let scpPort = 22
    const scpArgs: string[] = []
    let host: string | null = null

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === '-P' && i + 1 < args.length) {
            // scp uses -P for port; use as tunnel port too
            scpPort = parseInt(args[i + 1], 10)
            if (!Number.isFinite(scpPort) || scpPort <= 0 || scpPort > 65535) {
                console.error('Invalid port number')
                process.exit(1)
            }
            scpArgs.push(arg, args[++i])
        } else if (SCP_OPTIONS_WITH_ARG.has(arg) && i + 1 < args.length) {
            scpArgs.push(arg, args[++i])
        } else if (!host && !arg.startsWith('-') && arg.includes(':')) {
            // First argument with ':' is a remote spec (user@host:path)
            const atIdx = arg.indexOf('@')
            const colonIdx = arg.indexOf(':')
            if (atIdx >= 0 && atIdx < colonIdx) {
                host = arg.slice(atIdx + 1, colonIdx)
            } else {
                host = arg.slice(0, colonIdx)
            }
            scpArgs.push(arg)
        } else {
            scpArgs.push(arg)
        }
    }

    if (!host) {
        console.error('Usage: hapi scp [options] <source> <destination>')
        console.error('At least one path must be remote (user@hostname:path)')
        process.exit(1)
    }

    return { scpPort, host, scpArgs }
}

export const scpCommand: CommandDefinition = {
    name: 'scp',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        if (commandArgs.length === 0 || commandArgs[0] === '--help' || commandArgs[0] === '-h') {
            console.log(`${chalk.bold('hapi scp')} — SCP through hapi tunnel

${chalk.bold('Usage:')}
  hapi scp [options] <source> <destination>

${chalk.bold('Options:')}
  -P <port>    Remote SSH port for tunnel (default: 22)
  All other options are passed directly to scp.

${chalk.bold('Examples:')}
  hapi scp localfile.txt user@myserver:/tmp/
  hapi scp user@myserver:/etc/hosts ./hosts.bak
  hapi scp -r user@myserver:~/project/ ./local/
  hapi scp -P 2222 file.txt user@myserver:/tmp/`)
            process.exit(0)
        }

        await initializeToken()

        const { scpPort, host, scpArgs } = parseArgs(commandArgs)
        const proxyCommand = buildProxyCommand(host, scpPort)

        const fullArgs = [
            '-o', `ProxyCommand=${proxyCommand}`,
            ...scpArgs
        ]

        try {
            execFileSync('scp', fullArgs, {
                stdio: 'inherit',
                env: process.env
            })
        } catch (error: unknown) {
            const code = (error as { status?: number }).status ?? 1
            process.exit(code)
        }
    }
}
