import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import type { PiPermissionMode } from '@hapi/protocol/types'

export const piCommand: CommandDefinition = {
    name: 'pi', requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options: { startedBy?: 'runner' | 'terminal'; startingMode?: 'local' | 'remote'; permissionMode?: PiPermissionMode; model?: string; effort?: string; resumeSessionId?: string } = {}
            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]
                if (arg === '--started-by') options.startedBy = commandArgs[++i] as 'runner' | 'terminal'
                else if (arg === '--hapi-starting-mode') options.startingMode = commandArgs[++i] as 'local' | 'remote'
                else if (arg === '--yolo') options.permissionMode = 'yolo'
                else if (arg === '--permission-mode') options.permissionMode = commandArgs[++i] as PiPermissionMode
                else if (arg === '--model') options.model = commandArgs[++i]
                else if (arg === '--effort') options.effort = commandArgs[++i]
                else if (arg === '--resume' || arg === '--session') options.resumeSessionId = commandArgs[++i]
            }
            await initializeToken(); await maybeAutoStartServer(); await authAndSetupMachineIfNeeded()
            const { runPi } = await import('@/pi/runPi')
            await runPi(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}
