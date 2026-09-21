import React from 'react'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage } from '@/agent/types'
import { PermissionAdapter } from '@/agent/permissionAdapter'
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase'
import { PiDisplay } from '@/ui/ink/PiDisplay'
import { logger } from '@/ui/logger'
import { PiRpcClient } from './piRpcClient'
import { createPiExtension } from './piExtension'
import type { PiSession } from './session'

class PiRemoteLauncher extends RemoteLauncherBase {
    private client: PiRpcClient | null = null
    private permissions: PermissionAdapter | null = null
    private extension: Awaited<ReturnType<typeof createPiExtension>> | null = null
    private abortController = new AbortController()

    constructor(private readonly session: PiSession, private readonly initialModel?: string) {
        super(process.env.DEBUG ? session.logPath : undefined)
    }

    launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.handleExit('exit'), onSwitchToLocal: () => this.handleExit('switch') })
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(PiDisplay, context)
    }

    protected async runMainLoop(): Promise<void> {
        this.extension = await createPiExtension()
        await this.startClient()
        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(), onSwitch: () => this.handleExit('switch')
        })
        this.session.restartForProvider = async () => {
            await this.permissions?.cancelAll('Provider changed')
            await this.client?.disconnect()
            await this.startClient()
        }

        while (!this.shouldExit) {
            const batch = await this.session.queue.waitForMessagesAndGetAsString(this.abortController.signal)
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) continue
                break
            }
            if (batch.message.trim() === '/clear') {
                this.session.sendSessionEvent({ type: 'message', message: 'Start a new Pi session to clear context.' })
                continue
            }
            const client = this.client
            if (!client) throw new Error('Pi RPC is unavailable')
            if (batch.mode.model && batch.mode.model !== 'auto') await client.setModel(batch.mode.model)
            if (batch.mode.effort && batch.mode.effort !== 'default') await client.setThinkingLevel(batch.mode.effort)
            this.session.onThinkingChange(true)
            this.messageBuffer.addMessage(batch.message, 'user')
            try {
                const prompt = batch.mode.appendSystemPrompt
                    ? `${batch.mode.appendSystemPrompt}\n\n${batch.message}` : batch.message
                await client.prompt(prompt, (message) => this.handleMessage(message))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[pi-remote] prompt failed', error)
                this.session.sendSessionEvent({ type: 'message', message: `Pi prompt failed: ${message}` })
            } finally {
                this.session.onThinkingChange(false)
                if (this.session.queue.size() === 0 && !this.shouldExit) this.session.sendSessionEvent({ type: 'ready' })
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        this.session.restartForProvider = undefined
        await this.permissions?.cancelAll('Session ended')
        await this.client?.disconnect()
        await this.extension?.dispose()
        this.client = null
    }

    private async startClient(): Promise<void> {
        const client = new PiRpcClient({
            cwd: this.session.path, sessionId: this.session.sessionId,
            model: this.session.getModelMode() ?? this.initialModel,
            extensionPath: this.extension!.path,
            env: { ...this.session.piEnv, HAPI_SESSION_ID: this.session.client.sessionId }
        })
        const state = await client.initialize()
        this.client = client
        this.session.onSessionFound(state.sessionId)
        this.permissions = new PermissionAdapter(
            this.session.client, client,
            () => this.session.getPermissionMode()
        )
        const model = state.model
        if (model) this.updateModel(model)
    }

    private handleMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendCodexMessage(converted)
        if (message.type === 'text') this.messageBuffer.addMessage(message.text, 'assistant')
        if (message.type === 'tool_call') this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool')
        if (message.type === 'tool_result') this.messageBuffer.addMessage('Tool result received', 'result')
    }

    private updateModel(model: Record<string, unknown>): void {
        const provider = typeof model.provider === 'string' ? model.provider : ''
        const id = typeof model.id === 'string' ? model.id : ''
        if (!id) return
        const resolved = provider ? `${provider}/${id}` : id
        this.session.setModelMode(resolved)
        this.session.client.updateMetadata((metadata) => ({
            ...metadata, resolvedModel: resolved, resolvedModelProvider: provider || 'pi',
            ...(typeof model.contextWindow === 'number' ? { contextWindowTokens: model.contextWindow } : {})
        }))
        this.messageBuffer.addMessage(`[MODEL:${resolved}]`, 'system')
    }

    private async handleAbort(): Promise<void> {
        await this.client?.abort()
        this.session.queue.reset()
        this.session.onThinkingChange(false)
        this.abortController.abort()
        this.abortController = new AbortController()
    }

    private async handleExit(reason: 'switch' | 'exit'): Promise<void> {
        await this.requestExit(reason, () => this.handleAbort())
    }
}

export function piRemoteLauncher(session: PiSession, opts: { model?: string }): Promise<'switch' | 'exit'> {
    return new PiRemoteLauncher(session, opts.model).launch()
}
