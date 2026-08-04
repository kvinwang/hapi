import chalk from 'chalk'
import { isAxiosError } from 'axios'
import { ApiClient } from '@/api/api'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

export const sendCommand: CommandDefinition = {
    name: 'send',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        if (commandArgs.length < 2) {
            console.log('Usage: hapi send <session-id> <message>')
            process.exitCode = 1
            return
        }

        const sessionId = commandArgs[0]
        const message = commandArgs.slice(1).join(' ')

        await initializeToken()
        const api = await ApiClient.create()

        try {
            await api.sendMessageToSession(sessionId, message)
            console.log(chalk.green('Message sent.'))
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
