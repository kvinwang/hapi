import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { ApiClient } from '@/api/api'
import type { CommandDefinition } from './types'

export const inviteCommand: CommandDefinition = {
    name: 'invite',
    requiresRuntimeAssets: false,
    run: async (context) => {
        const subcommand = context.commandArgs[0]

        if (subcommand === 'create' || !subcommand) {
            await initializeToken()
            const api = await ApiClient.create()

            try {
                const result = await api.createInvite()
                console.log('')
                console.log(chalk.green('Invite created!'))
                console.log('')
                console.log(`  Code: ${chalk.bold(result.code)}`)
                console.log(`  Expires: ${new Date(result.expiresAt).toLocaleString()}`)
                console.log('')
                console.log(chalk.cyan('Send this command to the remote user:'))
                console.log('')
                console.log(`  ${chalk.bold(result.command)}`)
                console.log('')
            } catch (error: any) {
                const msg = error?.response?.data?.error ?? error?.message ?? 'Unknown error'
                console.error(chalk.red(`Failed to create invite: ${msg}`))
                process.exit(1)
            }
            return
        }

        console.error(chalk.red(`Unknown subcommand: ${subcommand}`))
        console.error(chalk.gray('Usage: hapi invite [create]'))
        process.exit(1)
    }
}
