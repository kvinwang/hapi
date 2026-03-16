import chalk from 'chalk'
import axios from 'axios'
import { initializeToken } from '@/ui/tokenInit'
import { getAuthToken } from '@/api/auth'
import { configuration } from '@/configuration'
import type { CommandDefinition } from './types'

type ExpiresIn = '1d' | '7d' | '30d' | 'never'
const VALID_EXPIRES: ExpiresIn[] = ['1d', '7d', '30d', 'never']

function parseArgs(args: string[]): { name?: string; expiresIn: ExpiresIn } {
    let name: string | undefined
    let expiresIn: ExpiresIn = '7d'

    for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--name' || args[i] === '-n') && args[i + 1]) {
            name = args[++i]
        } else if ((args[i] === '--expires' || args[i] === '-e') && args[i + 1]) {
            const val = args[++i] as ExpiresIn
            if (VALID_EXPIRES.includes(val)) {
                expiresIn = val
            } else {
                console.error(chalk.red(`Invalid expiry: ${val}. Must be one of: ${VALID_EXPIRES.join(', ')}`))
                process.exit(1)
            }
        }
    }

    return { name, expiresIn }
}

export const tokenCommand: CommandDefinition = {
    name: 'token',
    requiresRuntimeAssets: false,
    run: async (context) => {
        const subcommand = context.commandArgs[0]

        if (subcommand === 'create') {
            const apiKeyId = context.commandArgs[1]
            if (!apiKeyId || apiKeyId.startsWith('-')) {
                console.error(chalk.red('Usage: hapi token create <api-key-id> [--name <name>] [--expires 1d|7d|30d|never]'))
                console.error(chalk.gray('  Use "hapi token list" to see API key IDs'))
                process.exit(1)
            }

            const { name, expiresIn } = parseArgs(context.commandArgs.slice(2))
            const tokenName = name ?? `cli-${new Date().toISOString().slice(0, 10)}`

            await initializeToken()
            const token = getAuthToken()

            try {
                const response = await axios.post(
                    `${configuration.apiUrl}/api/api-keys/${encodeURIComponent(apiKeyId)}/tokens`,
                    { name: tokenName, expiresIn },
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 30_000
                    }
                )

                const data = response.data as { token: { name: string; expiresAt: number }; rawToken: string }
                console.log(chalk.green('Token created:'))
                console.log(`  Name:    ${data.token.name}`)
                console.log(`  Expires: ${data.token.expiresAt === 0 ? 'never' : new Date(data.token.expiresAt).toLocaleString()}`)
                console.log()
                console.log(chalk.yellow('  Token: ') + data.rawToken)
                console.log()
                console.log(chalk.gray('  Copy this token now. It will not be shown again.'))
            } catch (error: any) {
                const msg = error?.response?.data?.error ?? error?.message ?? 'Unknown error'
                console.error(chalk.red(`Failed to create token: ${msg}`))
                process.exit(1)
            }
            return
        }

        if (subcommand === 'list' || subcommand === 'ls') {
            await initializeToken()
            const token = getAuthToken()

            try {
                const response = await axios.get(
                    `${configuration.apiUrl}/api/api-keys`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                        timeout: 30_000
                    }
                )

                const data = response.data as { apiKeys: Array<{ id: string; name: string; keyPrefix: string; namespace: string; permissions: string[]; revokedAt: number | null; createdAt: number }> }
                if (data.apiKeys.length === 0) {
                    console.log(chalk.gray('No API keys found.'))
                    return
                }

                for (const key of data.apiKeys) {
                    const status = key.revokedAt ? chalk.red('revoked') : chalk.green('active')
                    const perms = key.permissions.length > 0 ? chalk.gray(` [${key.permissions.join(', ')}]`) : ''
                    console.log(`${status}  ${chalk.bold(key.id)}  ${key.name}  ${chalk.gray(key.keyPrefix + '...')}${perms}`)
                }
            } catch (error: any) {
                const msg = error?.response?.data?.error ?? error?.message ?? 'Unknown error'
                console.error(chalk.red(`Failed to list API keys: ${msg}`))
                process.exit(1)
            }
            return
        }

        console.error(chalk.red(`Unknown subcommand: ${subcommand ?? '(none)'}`))
        console.error(chalk.gray('Available: list, create <api-key-id> [--name <name>] [--expires 1d|7d|30d|never]'))
        process.exit(1)
    }
}
