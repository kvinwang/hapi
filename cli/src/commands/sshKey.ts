import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { ApiClient } from '@/api/api'
import type { CommandDefinition } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function resolveMachineId(input: string): Promise<string> {
    if (UUID_RE.test(input)) {
        return input
    }

    const api = await ApiClient.create()
    const machines = await api.listMachines()
    const matches = machines.filter(m =>
        m.metadata?.host === input || m.metadata?.displayName === input
    )

    if (matches.length === 0) {
        console.error(`No machine found matching "${input}"`)
        console.error('Available machines:')
        for (const m of machines) {
            const host = m.metadata?.host ?? 'unknown'
            const name = m.metadata?.displayName
            const label = name ? `${name} (${host})` : host
            console.error(`  ${m.id}  ${label}`)
        }
        process.exit(1)
    }

    if (matches.length > 1) {
        console.error(`Multiple machines match "${input}":`)
        for (const m of matches) {
            const host = m.metadata?.host ?? 'unknown'
            console.error(`  ${m.id}  ${host}`)
        }
        console.error('Please use the machine ID directly.')
        process.exit(1)
    }

    return matches[0].id
}

function readPublicKey(fileArg?: string): string {
    if (fileArg) {
        const filePath = resolve(fileArg)
        try {
            return readFileSync(filePath, 'utf-8').trim()
        } catch {
            console.error(chalk.red(`Failed to read key file: ${filePath}`))
            process.exit(1)
        }
    }

    const defaultKeyFiles = [
        'id_ed25519.pub',
        'id_rsa.pub',
        'id_ecdsa.pub',
    ]
    const sshDir = resolve(homedir(), '.ssh')

    for (const keyFile of defaultKeyFiles) {
        const filePath = resolve(sshDir, keyFile)
        try {
            return readFileSync(filePath, 'utf-8').trim()
        } catch {
            // try next
        }
    }

    console.error(chalk.red('No SSH public key found.'))
    console.error('Tried: ' + defaultKeyFiles.map(f => `~/.ssh/${f}`).join(', '))
    console.error('Specify a key file: hapi ssh-copy-id <machine> <path-to-key.pub>')
    process.exit(1)
}

export const sshKeyCommand: CommandDefinition = {
    name: 'ssh-copy-id',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        if (commandArgs.length === 0 || commandArgs[0] === '--help' || commandArgs[0] === '-h') {
            console.log(`${chalk.bold('hapi ssh-copy-id')} — Import SSH public key to a remote machine

${chalk.bold('Usage:')}
  hapi ssh-copy-id <machine> [pubkey-file]

${chalk.bold('Arguments:')}
  machine      Machine ID, hostname, or display name
  pubkey-file  Path to public key file (default: ~/.ssh/id_ed25519.pub, etc.)

${chalk.bold('Examples:')}
  hapi ssh-copy-id myserver
  hapi ssh-copy-id myserver ~/.ssh/id_rsa.pub`)
            process.exit(0)
        }

        const machineArg = commandArgs[0]
        const keyFileArg = commandArgs[1]

        await initializeToken()

        const machineId = await resolveMachineId(machineArg)
        const publicKey = readPublicKey(keyFileArg)

        console.log(chalk.dim(`Importing key to machine ${machineId}...`))

        const api = await ApiClient.create()
        try {
            const result = await api.importSshKey(machineId, publicKey)

            if (!result.success) {
                console.error(chalk.red(`Failed: ${result.error}`))
                process.exit(1)
            }

            if (result.added) {
                console.log(chalk.green('SSH key imported successfully.'))
            } else {
                console.log(chalk.yellow('SSH key already present on the machine.'))
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : 'Unknown error'
            console.error(chalk.red(`Error: ${msg}`))
            process.exit(1)
        }
    }
}
