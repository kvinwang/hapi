import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { logger } from '@/ui/logger'
import type { AgentMessage, PermissionRequest, PermissionResponse } from '@/agent/types'

type JsonObject = Record<string, unknown>
type Pending = { resolve: (value: JsonObject) => void; reject: (error: Error) => void }

export class PiRpcClient {
    private process: ChildProcessWithoutNullStreams | null = null
    private pending = new Map<string, Pending>()
    private buffer = ''
    private permissionHandler: ((request: PermissionRequest) => void) | null = null
    private updateHandler: ((message: AgentMessage) => void) | null = null
    private settled: (() => void) | null = null
    private sessionId = ''
    private lastUsage: JsonObject | null = null

    constructor(private readonly options: {
        cwd: string
        sessionId?: string | null
        model?: string
        extensionPath: string
        env?: NodeJS.ProcessEnv
    }) {}

    async initialize(): Promise<{ sessionId: string; model?: JsonObject }> {
        const args = ['--mode', 'rpc', '-e', this.options.extensionPath]
        if (this.options.sessionId) args.push('--session', this.options.sessionId)
        if (this.options.model && this.options.model !== 'auto') args.push('--model', this.options.model)
        this.process = spawn('pi', args, {
            cwd: this.options.cwd,
            env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', ...this.options.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32'
        })
        this.process.stdout.on('data', (chunk) => this.consume(chunk.toString()))
        this.process.stderr.on('data', (chunk) => logger.debug('[pi-rpc] stderr', chunk.toString()))
        this.process.on('error', (error) => this.failAll(error))
        this.process.on('exit', (code, signal) => this.failAll(new Error(`Pi RPC exited (${code ?? signal ?? 'unknown'})`)))
        const response = await this.command({ type: 'get_state' })
        const data = asObject(response.data)
        this.sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
        if (!this.sessionId) throw new Error('Pi RPC did not return a session ID')
        return { sessionId: this.sessionId, model: asObjectOrUndefined(data.model) }
    }

    async prompt(text: string, onUpdate: (message: AgentMessage) => void): Promise<void> {
        this.updateHandler = onUpdate
        const completion = new Promise<void>((resolve) => { this.settled = resolve })
        const response = await this.command({ type: 'prompt', message: text })
        if (response.success !== true) throw new Error(String(response.error ?? 'Pi rejected the prompt'))
        await completion
        this.updateHandler = null
    }

    async abort(): Promise<void> {
        await this.command({ type: 'abort' }).catch(() => {})
    }

    async cancelPrompt(_sessionId: string): Promise<void> { await this.abort() }

    async setModel(value: string): Promise<JsonObject | null> {
        const slash = value.indexOf('/')
        if (slash <= 0 || slash === value.length - 1) throw new Error('Pi models must use provider/model format')
        const response = await this.command({ type: 'set_model', provider: value.slice(0, slash), modelId: value.slice(slash + 1) })
        if (response.success !== true) throw new Error(String(response.error ?? 'Unable to switch Pi model'))
        return asObjectOrUndefined(response.data) ?? null
    }

    async setThinkingLevel(level: string): Promise<void> {
        if (level === 'default') return
        const response = await this.command({ type: 'set_thinking_level', level })
        if (response.success !== true) throw new Error(String(response.error ?? 'Unable to switch Pi thinking level'))
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler
    }

    async respondToPermission(request: PermissionRequest, response: PermissionResponse): Promise<void> {
        this.write({
            type: 'extension_ui_response', id: request.id,
            ...(response.outcome === 'selected' ? { confirmed: true } : { confirmed: false })
        })
    }

    async disconnect(): Promise<void> {
        const child = this.process
        this.process = null
        if (!child) return
        child.stdin.end()
        if (!child.killed) child.kill('SIGTERM')
    }

    private command(command: JsonObject): Promise<JsonObject> {
        const id = randomUUID()
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
            this.write({ ...command, id })
        })
    }

    private write(value: JsonObject): void {
        if (!this.process?.stdin.writable) throw new Error('Pi RPC is not running')
        this.process.stdin.write(`${JSON.stringify(value)}\n`)
    }

    private consume(chunk: string): void {
        this.buffer += chunk
        while (true) {
            const newline = this.buffer.indexOf('\n')
            if (newline < 0) return
            const line = this.buffer.slice(0, newline).replace(/\r$/, '')
            this.buffer = this.buffer.slice(newline + 1)
            if (!line) continue
            try { this.handle(JSON.parse(line) as JsonObject) } catch (error) { logger.debug('[pi-rpc] invalid JSON', { line, error }) }
        }
    }

    private handle(event: JsonObject): void {
        if (event.type === 'response' && typeof event.id === 'string') {
            const pending = this.pending.get(event.id)
            if (pending) {
                this.pending.delete(event.id)
                pending.resolve(event)
            }
            return
        }
        if (event.type === 'extension_ui_request' && event.method === 'confirm' && typeof event.id === 'string') {
            const rawInput = parseJson(typeof event.message === 'string' ? event.message : '')
            this.permissionHandler?.({
                id: event.id, sessionId: this.sessionId, toolCallId: typeof rawInput?.toolCallId === 'string' ? rawInput.toolCallId : event.id,
                title: typeof event.title === 'string' ? event.title : 'Pi tool', kind: typeof rawInput?.toolName === 'string' ? rawInput.toolName : undefined,
                rawInput: rawInput?.input, options: [
                    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
                    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
                ]
            })
            return
        }
        if (event.type === 'tool_execution_start') {
            this.updateHandler?.({ type: 'tool_call', id: String(event.toolCallId), name: String(event.toolName), input: event.args, status: 'in_progress' })
            return
        }
        if (event.type === 'tool_execution_end') {
            this.updateHandler?.({ type: 'tool_result', id: String(event.toolCallId), output: event.result, status: event.isError ? 'failed' : 'completed' })
            return
        }
        if (event.type === 'message_end') {
            const message = asObject(event.message)
            if (message.role === 'assistant') {
                const text = Array.isArray(message.content)
                    ? message.content.filter((part) => asObject(part).type === 'text').map((part) => String(asObject(part).text ?? '')).join('')
                    : ''
                if (text) this.updateHandler?.({ type: 'text', text })
                this.lastUsage = asObjectOrUndefined(message.usage) ?? null
            }
            return
        }
        if (event.type === 'agent_settled') {
            const usage = this.lastUsage
            this.updateHandler?.({
                type: 'turn_complete', stopReason: 'stop',
                ...(usage ? { usage: {
                    inputTokens: numberValue(usage.input), outputTokens: numberValue(usage.output),
                    cacheReadTokens: numberValue(usage.cacheRead), cacheCreationTokens: numberValue(usage.cacheWrite),
                    totalTokens: numberValue(usage.totalTokens) || undefined
                } } : {})
            })
            this.settled?.()
            this.settled = null
        }
    }

    private failAll(error: Error): void {
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        this.settled?.()
        this.settled = null
    }
}

function asObject(value: unknown): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {} }
function asObjectOrUndefined(value: unknown): JsonObject | undefined { const result = asObject(value); return Object.keys(result).length ? result : undefined }
function numberValue(value: unknown): number { return typeof value === 'number' ? value : 0 }
function parseJson(value: string): JsonObject | null { try { return asObject(JSON.parse(value)) } catch { return null } }
