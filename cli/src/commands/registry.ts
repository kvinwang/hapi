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
import { inviteCommand } from './invite'
import { machinesCommand, machineCommand } from './machines'
import { scpCommand } from './scp'
import { sendCommand } from './send'
import { sshCommand } from './ssh'
import { sshKeyCommand } from './sshKey'
import { mcpCommand } from './mcp'
import { notifyCommand } from './notify'
import { callCommand } from './call'
import { tokenCommand } from './token'
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
    inviteCommand,
    machineCommand,
    machinesCommand,
    { ...machinesCommand, name: 'lsm' },
    scpCommand,
    sendCommand,
    sshCommand,
    sshKeyCommand,
    tokenCommand,
    doctorCommand,
    runnerCommand,
    callCommand,
    notifyCommand
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
