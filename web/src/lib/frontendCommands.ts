import { z } from 'zod'
import { voiceUiControlSchema, type VoiceUiControl } from './voiceUiControlSchema'

const onOff = z.enum(['on', 'off']).transform(value => value === 'on')
const text = z.string().trim().min(1)
const seconds = z.coerce.number().int().min(1).max(60)

type Command = {
    path: string
    usage: string
    description: string
    common?: boolean
    readOnly?: boolean
    args: z.ZodType<VoiceUiControl>
}

const commands: Command[] = [
    { path: 'ui status', usage: '', description: 'Inspect current voice settings and draft state without changing them.', common: true, readOnly: true,
        args: z.tuple([]).transform(() => ({ action: 'ui_status' })) },
    { path: 'draft clear', usage: '', description: 'Discard the current draft and pending speech.', common: true,
        args: z.tuple([]).transform(() => ({ action: 'draft_clear' })) },
    { path: 'draft send', usage: '', description: 'Request sending the current draft once; returns before delivery completes. Only on explicit send intent.', common: true,
        args: z.tuple([]).transform(() => ({ action: 'draft_send' })) },
    { path: 'draft choose', usage: '<1-4>', description: 'Adopt a displayed draft alternative without sending it.', common: true,
        args: z.tuple([z.coerce.number().int().min(1).max(4)]).transform(([index]) => ({ action: 'draft_choose', index })) },
    { path: 'draft pending', usage: '<include|dismiss> <index>', description: 'Include or dismiss an existing pending speech fragment (1-based).',
        args: z.tuple([z.enum(['include', 'dismiss']), z.coerce.number().int().min(1)]).transform(([value, index]) => ({ action: 'draft_pending', index, include: value === 'include' })) },
    { path: 'draft delay', usage: '<seconds>', description: 'Set the 1–60 second auto-send delay without changing its enabled state.',
        args: z.tuple([seconds]).transform(([delay]) => ({ action: 'auto_send', delay })) },
    { path: 'mic enabled', usage: '<on|off>', description: 'Resume or pause microphone capture.', common: true,
        args: z.tuple([onOff]).transform(([enabled]) => ({ action: 'mic_enabled', enabled })) },
    { path: 'readback devices', usage: '', description: 'List exposed output devices and the current routing status.', readOnly: true,
        args: z.tuple([]).transform(() => ({ action: 'readback_devices' })) },
    { path: 'readback output', usage: '<speaker|system|device-id>', description: 'Request output routing; use an exposed ID from readback devices. Cannot open browser permission pickers.',
        args: z.tuple([text]).transform(([device]) => ({ action: 'readback_output', device })) },
    { path: 'draft language', usage: '<original|zh|en>', description: 'Keep the spoken language or translate drafts.',
        common: true, args: z.tuple([z.enum(['original', 'zh', 'en'])]).transform(([language]) => ({ action: 'draft_language', language })) },
    { path: 'draft alternatives', usage: '<on|off>', description: 'Generate and show alternative wording, independently of translation.',
        common: true, args: z.tuple([onOff]).transform(([enabled]) => ({ action: 'draft_alternatives', enabled })) },
    { path: 'draft panel', usage: '<show|hide>', description: 'Show or hide the draft panel.',
        common: true, args: z.tuple([z.enum(['show', 'hide'])]).transform(([value]) => ({ action: 'draft_panel', open: value === 'show' })) },
    { path: 'draft mode', usage: '<auto|manual>', description: 'Set automatic or manual panel visibility.',
        args: z.tuple([z.enum(['auto', 'manual'])]).transform(([mode]) => ({ action: 'draft_mode', mode })) },
    { path: 'draft auto-send', usage: '<on|off> [seconds]', description: 'Enable or disable automatic delivery; optional delay is 1–60 seconds.',
        common: true, args: z.tuple([onOff, seconds.optional()]).transform(([enabled, delay]) => ({ action: 'auto_send', enabled, ...(delay === undefined ? {} : { delay }) })) },
    { path: 'mic sensitivity', usage: '<0-100>', description: 'Set microphone sensitivity.',
        args: z.tuple([z.coerce.number().int().min(0).max(100)]).transform(([value]) => ({ action: 'mic_sensitivity', value })) },
    { path: 'mic environment', usage: '<normal|noisy|very-noisy>', description: 'Pick a noise preset; resets mic sensitivity to its default.',
        args: z.tuple([z.enum(['normal', 'noisy', 'very-noisy'])]).transform(([environment]) => ({ action: 'mic_environment', environment })) },
    { path: 'readback volume', usage: '<50-300>', description: 'Set spoken output volume in percent (100 = unchanged).',
        common: true, args: z.tuple([z.coerce.number().int().min(50).max(300)]).transform(([value]) => ({ action: 'readback_volume', value })) },
    { path: 'readback duck-threshold', usage: '<-50..0|off>', description: 'Mic level in dBFS above which talking lowers read-aloud; lower triggers more easily, off never lowers it.',
        args: z.tuple([z.union([z.literal('off').transform(() => 0), z.coerce.number().int().min(-50).max(0)])]).transform(([value]) => ({ action: 'duck_threshold', value })) },
    { path: 'readback duck-level', usage: '<0-100>', description: 'Percent of read-aloud volume kept while the user talks over it (100 = not lowered).',
        args: z.tuple([z.coerce.number().int().min(0).max(100)]).transform(([value]) => ({ action: 'duck_level', value })) },
    { path: 'terminal execute', usage: '<on|off>', description: 'Whether terminal voice drafts press Enter after typing.',
        args: z.tuple([onOff]).transform(([enabled]) => ({ action: 'terminal_execute', enabled })) },
    { path: 'voice glow', usage: '<on|off>', description: 'Show or hide the screen-edge voice glow.',
        args: z.tuple([onOff]).transform(([enabled]) => ({ action: 'edge_glow', enabled })) },
    { path: 'readback language', usage: '<zh|en>', description: 'Set read-aloud language, independently of draft translation.',
        common: true, args: z.tuple([z.enum(['zh', 'en'])]).transform(([language]) => ({ action: 'readback_language', language })) },
    { path: 'readback enabled', usage: '<on|off>', description: 'Enable or disable automatic read-aloud.',
        args: z.tuple([onOff]).transform(([enabled]) => ({ action: 'readback', enabled })) },
    { path: 'readback own-messages', usage: '<on|off>', description: 'Also read aloud the messages the user sends.',
        args: z.tuple([onOff]).transform(([enabled]) => ({ action: 'readback_own', enabled })) },
    { path: 'readback final-only', usage: '<on|off>', description: 'Read only the final reply of each agent turn, skipping progress notes in between.',
        args: z.tuple([onOff]).transform(([enabled]) => ({ action: 'readback_final_only', enabled })) },
    { path: 'readback stop', usage: '', description: 'Interrupt current read-aloud and its queue.',
        common: true, args: z.tuple([]).transform(() => ({ action: 'stop_readback' })) },
    { path: 'readback replay', usage: '["focus"]', description: 'Read the latest reply again, optionally focusing on a topic.',
        common: true, args: z.tuple([text.max(500).optional()]).transform(([focus]) => ({ action: 'replay_readback', ...(focus ? { focus } : {}) })) },
    { path: 'readback ask', usage: '"question"', description: 'Ask about the latest reply; may forward the question to the coding session.',
        args: z.tuple([text.max(2000)]).transform(([question]) => ({ action: 'answer_readback', question })) },
    { path: 'session list', usage: '["query"]', description: 'Open the native session panel with numbered active sessions, or fetch candidates for a specific lookup.',
        common: true, args: z.tuple([text.max(160).optional()]).transform(([query]) => ({ action: 'list_sessions', ...(query ? { query } : {}) })) },
    { path: 'session switch', usage: '<session-id>', description: 'Switch to an active session ID obtained from session list.',
        common: true, args: z.tuple([text]).transform(([sessionId]) => ({ action: 'switch_session', sessionId })) },
    { path: 'session suggest', usage: '"query" <session-id> [session-id ...]', description: 'Show up to five ambiguous matches from session list.',
        args: z.tuple([text.max(160), text]).rest(text).transform(([query, ...sessionIds]) => ({ action: 'suggest_sessions', query, sessionIds })) },
    { path: 'session select', usage: '<index>', description: 'Select an entry in the displayed candidate list.',
        args: z.tuple([z.coerce.number().int().min(1)]).transform(([index]) => ({ action: 'select_session', index })) },
    { path: 'session cancel', usage: '', description: 'Dismiss session selection.',
        args: z.tuple([]).transform(() => ({ action: 'cancel_selection' })) },
    { path: 'voice reset', usage: '', description: 'Reset voice history and candidates, not coding-session messages.',
        args: z.tuple([]).transform(() => ({ action: 'reset_voice' })) }
]

export function frontendCommandHelp(prefix = ''): string {
    const matching = commands.filter(command => command.path === prefix || command.path.startsWith(`${prefix} `) || !prefix)
    if (!matching.length) throw new Error(`Unknown command: ${prefix}. Use help to list commands.`)
    return [
        'Frontend commands (browser only; no system shell or JavaScript).',
        'One command per call. Quote arguments containing spaces with single or double quotes; backslash escapes the next character.',
        'No pipelines, command chaining, redirection, variable expansion, or substitution. Metacharacters inside quotes are literal text.',
        'help [command] or <command> --help: show this help without changing state.',
        ...matching.map(command => `${command.path}${command.usage ? ` ${command.usage}` : ''}\n  ${command.description}`)
    ].join('\n')
}

export function frontendCommandSummary(): string {
    return [
        'Common frontend commands (one per control_ui call; quote arguments containing spaces):',
        ...commands.filter(command => command.common).map(command => `${command.path}${command.usage ? ` ${command.usage}` : ''}`),
        `Other command groups: ${[...new Set(commands.map(command => command.path.split(' ')[0]))].join(', ')}.`,
        'Use help or help <group> for full usage, limits, and less-common operations. Use ui status before relying on current settings.',
        'Never execute system shell commands or JavaScript. Sending a draft requires explicit user intent; selecting a candidate never sends it.'
    ].join('\n')
}

function tokenize(command: string): string[] {
    const tokens: string[] = []
    let token = '', quote = '', escaped = false, started = false
    for (const char of command) {
        if (escaped) { token += char; escaped = false; started = true }
        else if (char === '\\' && quote !== "'") { escaped = true; started = true }
        else if (quote) {
            if (char === quote) quote = ''
            else token += char
        } else if (char === '"' || char === "'") { quote = char; started = true }
        else if (/\s/.test(char)) {
            if (started) tokens.push(token)
            token = ''; started = false
        } else {
            if (/[;|&<>`$]/.test(char)) throw new Error('Shell operators and expansions are not supported. Use one frontend command per call.')
            token += char; started = true
        }
    }
    if (quote || escaped) throw new Error('Unclosed quote or trailing escape in frontend command.')
    if (started) tokens.push(token)
    return tokens
}

const toolArguments = z.object({ command: z.string().trim().min(1).max(4096) }).strict()

export function executeFrontendCommand(input: unknown, execute: (control: VoiceUiControl, metadata: { readOnly: boolean }) => unknown): unknown {
    const { command } = toolArguments.parse(input)
    const tokens = tokenize(command)
    if (tokens[0] === 'help') return { ok: true, help: frontendCommandHelp(tokens.slice(1).join(' ')) }
    if (tokens.at(-1) === '--help') return { ok: true, help: frontendCommandHelp(tokens.slice(0, -1).join(' ')) }
    const entry = commands.find(candidate => candidate.path === tokens.slice(0, candidate.path.split(' ').length).join(' '))
    if (!entry) throw new Error('Unknown frontend command. Use help to list commands.')
    const args = entry.args.safeParse(tokens.slice(entry.path.split(' ').length))
    if (!args.success) throw new Error(`Usage: ${entry.path} ${entry.usage}`.trim())
    const control = voiceUiControlSchema.safeParse(args.data)
    if (!control.success) throw new Error(`Invalid arguments. Usage: ${entry.path} ${entry.usage}`.trim())
    return execute(control.data, { readOnly: entry.readOnly ?? false }) ?? { ok: true }
}
