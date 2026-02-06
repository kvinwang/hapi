import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { ApiClient } from '@/api/api'
import type { CommandDefinition } from './types'

export const machinesCommand: CommandDefinition = {
    name: 'machines',
    requiresRuntimeAssets: false,
    run: async () => {
        await initializeToken()
        const api = await ApiClient.create()

        const machines = await api.listMachines()

        if (machines.length === 0) {
            console.log(chalk.gray('No machines found.'))
            return
        }

        for (const machine of machines) {
            const status = machine.active
                ? chalk.green('online')
                : chalk.gray('offline')
            const host = machine.metadata?.host ?? 'unknown'
            const platform = machine.metadata?.platform ?? ''
            const name = machine.metadata?.displayName

            const label = name
                ? `${name} (${host})`
                : host

            console.log(`${status}  ${chalk.bold(machine.id)}  ${label}  ${chalk.gray(platform)}`)
        }
    }
}
