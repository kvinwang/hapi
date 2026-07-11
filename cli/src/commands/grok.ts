import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import type { GrokPermissionMode } from '@hapi/protocol/types'

export const grokCommand: CommandDefinition = {
    name: 'grok',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options: {
                startedBy?: 'runner' | 'terminal'
                startingMode?: 'local' | 'remote'
                permissionMode?: GrokPermissionMode
                model?: string
                resumeSessionId?: string
                forkFromSessionId?: string
            } = {}

            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]
                if (arg === '--started-by') {
                    options.startedBy = commandArgs[++i] as 'runner' | 'terminal'
                } else if (arg === '--hapi-starting-mode') {
                    const value = commandArgs[++i]
                    if (value === 'local' || value === 'remote') {
                        options.startingMode = value
                    } else {
                        throw new Error('Invalid --hapi-starting-mode (expected local or remote)')
                    }
                } else if (arg === '--yolo') {
                    options.permissionMode = 'bypassPermissions'
                } else if (arg === '--permission-mode') {
                    const value = commandArgs[++i]
                    if (!value) {
                        throw new Error('Missing --permission-mode value')
                    }
                    options.permissionMode = value as GrokPermissionMode
                } else if (arg === '--resume') {
                    const sessionId = commandArgs[++i]
                    if (!sessionId) {
                        throw new Error('Missing --resume value')
                    }
                    options.resumeSessionId = sessionId
                } else if (arg === '--fork-from') {
                    const sessionId = commandArgs[++i]
                    if (!sessionId) {
                        throw new Error('Missing --fork-from value')
                    }
                    options.forkFromSessionId = sessionId
                } else if (arg === '--model') {
                    const model = commandArgs[++i]
                    if (!model) {
                        throw new Error('Missing --model value')
                    }
                    options.model = model
                }
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runGrok } = await import('@/grok/runGrok')
            await runGrok(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
