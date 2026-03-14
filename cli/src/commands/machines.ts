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

export const machineCommand: CommandDefinition = {
    name: 'machine',
    requiresRuntimeAssets: false,
    run: async (context) => {
        const subcommand = context.commandArgs[0]
        if (subcommand === 'delete' || subcommand === 'rm') {
            const machineId = context.commandArgs[1]
            if (!machineId) {
                console.error(chalk.red('Usage: hapi machine delete <machine-id>'))
                process.exit(1)
            }

            await initializeToken()
            const api = await ApiClient.create()

            try {
                await api.deleteMachine(machineId)
                console.log(chalk.green(`Machine ${machineId} deleted.`))
            } catch (error: any) {
                const msg = error?.response?.data?.error ?? error?.message ?? 'Unknown error'
                console.error(chalk.red(`Failed to delete machine: ${msg}`))
                process.exit(1)
            }
            return
        }

        console.error(chalk.red(`Unknown subcommand: ${subcommand ?? '(none)'}`))
        console.error(chalk.gray('Available: delete <machine-id>'))
        process.exit(1)
    }
}
