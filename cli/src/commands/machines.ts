import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { ApiClient } from '@/api/api'
import type { CommandDefinition } from './types'
import packageJson from '../../package.json'

const currentVersion = `hapi/${packageJson.version}`

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
            const version = machine.metadata?.happyCliVersion ?? ''

            const label = name
                ? `${name} (${host})`
                : host

            const versionStr = version
                ? (version !== currentVersion ? chalk.yellow(version) : chalk.gray(version))
                : chalk.red('unknown')

            const notes = machine.notes ? chalk.cyan(` [${machine.notes}]`) : ''
            console.log(`${status}  ${chalk.bold(machine.id)}  ${label}  ${chalk.gray(platform)}  ${versionStr}${notes}`)
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

        if (subcommand === 'note') {
            const machineId = context.commandArgs[1]
            if (!machineId) {
                console.error(chalk.red('Usage: hapi machine note <machine-id> [note text...]'))
                process.exit(1)
            }

            const noteText = context.commandArgs.slice(2).join(' ')

            await initializeToken()
            const api = await ApiClient.create()

            try {
                await api.updateMachineNotes(machineId, noteText || null)
                if (noteText) {
                    console.log(chalk.green(`Note updated for ${machineId}: ${noteText}`))
                } else {
                    console.log(chalk.green(`Note cleared for ${machineId}`))
                }
            } catch (error: any) {
                const msg = error?.response?.data?.error ?? error?.message ?? 'Unknown error'
                console.error(chalk.red(`Failed to update note: ${msg}`))
                process.exit(1)
            }
            return
        }

        console.error(chalk.red(`Unknown subcommand: ${subcommand ?? '(none)'}`))
        console.error(chalk.gray('Available: delete <machine-id>, note <machine-id> [text]'))
        process.exit(1)
    }
}
