import { authCommand } from './auth'
import { claudeCommand } from './claude'
import { codexCommand } from './codex'
import { connectCommand } from './connect'
import { runnerCommand } from './runner'
import { doctorCommand } from './doctor'
import { geminiCommand } from './gemini'
import { opencodeCommand } from './opencode'
import { helpCommand, unknownCommand } from './help'
import { hookForwarderCommand } from './hookForwarder'
import { machinesCommand } from './machines'
import { scpCommand } from './scp'
import { sshCommand } from './ssh'
import { sshKeyCommand } from './sshKey'
import { mcpCommand } from './mcp'
import { notifyCommand } from './notify'
import { probeCommand } from './probe'
import { hubCommand } from './hub'
import { sessionCommand } from './session'
import type { CommandContext, CommandDefinition } from './types'

const COMMANDS: CommandDefinition[] = [
    authCommand,
    claudeCommand,
    connectCommand,
    codexCommand,
    geminiCommand,
    opencodeCommand,
    mcpCommand,
    hubCommand,
    { ...hubCommand, name: 'server' },
    sessionCommand,
    helpCommand,
    hookForwarderCommand,
    machinesCommand,
    { ...machinesCommand, name: 'lsm' },
    scpCommand,
    sshCommand,
    sshKeyCommand,
    doctorCommand,
    runnerCommand,
    notifyCommand,
    probeCommand
]

const commandMap = new Map<string, CommandDefinition>()
for (const command of COMMANDS) {
    commandMap.set(command.name, command)
}

export function resolveCommand(args: string[]): { command: CommandDefinition; context: CommandContext } {
    const subcommand = args[0]

    if (!subcommand) {
        return {
            command: helpCommand,
            context: { args, subcommand: undefined, commandArgs: [] }
        }
    }

    const command = commandMap.get(subcommand)

    if (!command) {
        return {
            command: unknownCommand,
            context: { args, subcommand, commandArgs: args }
        }
    }

    return {
        command,
        context: {
            args,
            subcommand,
            commandArgs: args.slice(1)
        }
    }
}
