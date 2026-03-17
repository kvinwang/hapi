import chalk from 'chalk'
import { isAxiosError } from 'axios'
import { ApiClient } from '@/api/api'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

export const sendCommand: CommandDefinition = {
    name: 'send',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        let wait = false
        const filtered: string[] = []

        for (const arg of commandArgs) {
            if (arg === '--wait') {
                wait = true
            } else {
                filtered.push(arg)
            }
        }

        if (filtered.length < 2) {
            console.log('Usage: hapi send <session-id> <message> [--wait]')
            console.log('')
            console.log('Options:')
            console.log('  --wait    Wait for assistant reply and output text')
            process.exitCode = 1
            return
        }

        const sessionId = filtered[0]
        const message = filtered.slice(1).join(' ')

        await initializeToken()
        const api = await ApiClient.create()

        try {
            const result = await api.sendMessageToSession(sessionId, message, wait)

            if (!wait) {
                console.log(chalk.green('Message sent.'))
            } else if (result.reply) {
                console.log(result.reply)
            }
        } catch (error) {
            if (isAxiosError(error) && error.response?.data?.error) {
                console.error(chalk.red('Error:'), error.response.data.error)
            } else {
                console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            }
            process.exitCode = 1
        }
    }
}
