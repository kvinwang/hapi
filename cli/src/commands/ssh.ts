import { execFileSync } from 'node:child_process'
import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { getHappyCliCommand } from '@/utils/spawnHappyCLI'
import type { CommandDefinition } from './types'

/**
 * hapi ssh — wrapper around ssh that auto-injects ProxyCommand
 *
 * Usage mirrors ssh:
 *   hapi ssh user@hostname
 *   hapi ssh -P 2222 user@hostname
 *   hapi ssh user@hostname -L 8080:localhost:80
 *   hapi ssh hostname  (uses current user)
 *
 * Translates to:
 *   ssh -o ProxyCommand="hapi connect <hostname> <port>" <all ssh args>
 */

function buildProxyCommand(host: string, port: number): string {
    const { command, args } = getHappyCliCommand(['connect', host, String(port)])
    // Quote the full command for ProxyCommand
    const parts = [command, ...args].map(p => p.includes(' ') ? `"${p}"` : p)
    return parts.join(' ')
}

function parseArgs(args: string[]): { sshPort: number; host: string; sshArgs: string[] } {
    let sshPort = 22
    const sshArgs: string[] = []
    let host: string | null = null

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === '-P' && i + 1 < args.length) {
            // Our custom -P flag for the tunnel port (uppercase, like scp)
            sshPort = parseInt(args[++i], 10)
            if (!Number.isFinite(sshPort) || sshPort <= 0 || sshPort > 65535) {
                console.error('Invalid port number')
                process.exit(1)
            }
        } else if (arg === '-p' && i + 1 < args.length) {
            // Standard ssh -p flag — pass through to ssh AND use as tunnel port
            sshPort = parseInt(args[i + 1], 10)
            sshArgs.push(arg, args[++i])
        } else if (!host && !arg.startsWith('-')) {
            // First non-option argument is the destination
            host = arg
            sshArgs.push(arg)
        } else {
            sshArgs.push(arg)
        }
    }

    if (!host) {
        console.error('Usage: hapi ssh [options] [user@]hostname [command]')
        console.error('Options:')
        console.error('  -P <port>    Tunnel port (default: 22)')
        console.error('  All other ssh options are passed through.')
        process.exit(1)
    }

    // Extract the hostname from user@hostname
    const hostname = host.includes('@') ? host.split('@').pop()! : host

    return { sshPort, host: hostname, sshArgs }
}

export const sshCommand: CommandDefinition = {
    name: 'ssh',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        if (commandArgs.length === 0 || commandArgs[0] === '--help' || commandArgs[0] === '-h') {
            console.log(`${chalk.bold('hapi ssh')} — SSH through hapi tunnel

${chalk.bold('Usage:')}
  hapi ssh [user@]hostname [ssh-options] [command]
  hapi ssh -P 2222 [user@]hostname

${chalk.bold('Options:')}
  -P <port>    Remote SSH port for tunnel (default: 22)
  -p <port>    Same as ssh -p (also sets tunnel port)
  All other options are passed directly to ssh.

${chalk.bold('Examples:')}
  hapi ssh user@myserver
  hapi ssh -P 2222 user@myserver
  hapi ssh myserver ls -la
  hapi ssh user@myserver -L 8080:localhost:80`)
            process.exit(0)
        }

        await initializeToken()

        const { sshPort, host, sshArgs } = parseArgs(commandArgs)
        const proxyCommand = buildProxyCommand(host, sshPort)

        const fullArgs = [
            '-o', `ProxyCommand=${proxyCommand}`,
            ...sshArgs
        ]

        try {
            execFileSync('ssh', fullArgs, {
                stdio: 'inherit',
                env: process.env
            })
        } catch (error: unknown) {
            // execFileSync throws on non-zero exit; ssh already printed its error
            const code = (error as { status?: number }).status ?? 1
            process.exit(code)
        }
    }
}
