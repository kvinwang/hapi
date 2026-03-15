import packageJson from '../../package.json'
import { ensureRuntimeAssets } from '@/runtime/assets'
import { isBunCompiled } from '@/projectPath'
import { logger } from '@/ui/logger'
import { getCliArgs } from '@/utils/cliArgs'
import { showTopLevelHelp } from './help'
import { resolveCommand } from './registry'

export async function runCli(): Promise<void> {
    const args = getCliArgs()

    const firstArg = args[0]

    if (firstArg === '-v' || firstArg === '--version') {
        console.log(`hapi version: ${packageJson.version}`)
        process.exit(0)
    }

    if (!firstArg || firstArg === '-h' || firstArg === '--help') {
        showTopLevelHelp()
        process.exit(0)
    }

    if (isBunCompiled()) {
        process.env.DEV = 'false'
    }

    const { command, context } = resolveCommand(args)

    if (command.requiresRuntimeAssets) {
        await ensureRuntimeAssets()
        logger.debug('Starting hapi CLI with args: ', process.argv)
    }

    await command.run(context)
}
