import chalk from 'chalk'
import type { CommandDefinition } from './types'

export function showTopLevelHelp(): void {
    console.log(`
${chalk.bold('hapi')} - Claude Code On the Go

${chalk.bold('Usage:')}
  hapi <command> [options]

${chalk.bold('AI Agent Commands:')}
  hapi claude            Start Claude Code session
  hapi codex             Start Codex session
  hapi gemini            Start Gemini ACP session
  hapi opencode          Start OpenCode ACP session

${chalk.bold('Infrastructure Commands:')}
  hapi hub               Start the API + web hub
  hapi server            Alias for hapi hub
  hapi runner            Manage background service
  hapi mcp               Start MCP stdio bridge

${chalk.bold('Machine & Connectivity Commands:')}
  hapi lsm               List all machines and their IDs
  hapi ssh               SSH through hapi tunnel
  hapi scp               Copy files via hapi tunnel
  hapi ssh-copy-id       Import SSH public key to a remote machine
  hapi connect           TCP tunnel (SSH ProxyCommand)
  hapi connect --probe   Probe tunnel protocol & latency

${chalk.bold('Other Commands:')}
  hapi auth              Manage authentication
  hapi doctor            System diagnostics & troubleshooting
  hapi notify            Send notification
  hapi session           Session utilities (history, create, set-title)
  hapi upload            Upload file and print share URL

${chalk.bold('Examples:')}
  hapi claude             Start a Claude Code session
  hapi claude --resume    Resume last Claude session
  hapi claude --yolo      Start with bypassing permissions
  hapi lsm               List connected machines

${chalk.bold('Options:')}
  -v, --version          Show version
  -h, --help             Show this help

Run ${chalk.cyan('hapi <command> --help')} for help on a specific command.
`)
}

export const helpCommand: CommandDefinition = {
    name: 'help',
    requiresRuntimeAssets: false,
    run: async () => {
        showTopLevelHelp()
        process.exit(0)
    }
}

export const unknownCommand: CommandDefinition = {
    name: 'unknown',
    requiresRuntimeAssets: false,
    run: async ({ subcommand }) => {
        console.error(chalk.red(`Unknown command: ${subcommand}`))
        console.error('')
        showTopLevelHelp()
        process.exit(1)
    }
}
