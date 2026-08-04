import { getShellCommand, isShellToolCall } from '@/lib/toolInputUtils'

export type HapiSendCommand = {
    target: string | null
    message: string
}

// Match only shell command positions, not incidental text such as `echo "hapi send ..."`.
const HAPI_SEND_AT_COMMAND_POSITION = /(?:^|[\n;]|&&|\|\|?|&)\s*(?:command\s+)?(?:[\w./-]+\/)?hapi\s+send(?:\s+|$)/g

function readShellWords(command: string, start: number): string[] {
    const words: string[] = []
    let value = ''
    let hasValue = false
    let quote: "'" | '"' | null = null

    for (let index = start; index < command.length; index += 1) {
        const char = command[index]
        if (!quote && /\s/.test(char)) {
            if (hasValue) {
                words.push(value)
                value = ''
                hasValue = false
            }
            continue
        }
        if (!quote && (char === ';' || char === '|' || char === '&')) break
        if (char === "'" || char === '"') {
            if (!quote) {
                quote = char
                hasValue = true
                continue
            }
            if (quote === char) {
                quote = null
                continue
            }
        }
        if (char === '\\' && quote !== "'" && index + 1 < command.length) {
            value += command[index + 1]
            hasValue = true
            index += 1
            continue
        }
        value += char
        hasValue = true
    }

    if (hasValue) words.push(value)
    return words
}

export function parseHapiSendCommand(command: string): HapiSendCommand | null {
    HAPI_SEND_AT_COMMAND_POSITION.lastIndex = 0
    const match = HAPI_SEND_AT_COMMAND_POSITION.exec(command)
    if (!match) return null

    const words = readShellWords(command, match.index + match[0].length)
    // A real send requires both a target session and message text. Calls such as
    // `hapi send 2>&1` only print usage and must remain ordinary shell tools.
    if (words.length < 2 || words[0].length === 0 || words.slice(1).join(' ').length === 0) {
        return null
    }
    return {
        target: words[0] ?? null,
        message: words.slice(1).join(' ')
    }
}

export function getHapiSendCommand(toolName: string, input: unknown): HapiSendCommand | null {
    if (!isShellToolCall(toolName, input)) return null
    const command = getShellCommand(input)
    return command ? parseHapiSendCommand(command) : null
}
