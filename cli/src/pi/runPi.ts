import { z } from 'zod'
import { bootstrapSession } from '@/agent/sessionFactory'
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { hashObject } from '@/utils/deterministicJson'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import type { PiSession } from './session'
import type { PiMode, PiProviderConfig, PermissionMode } from './types'
import { piLoop } from './loop'
import { preparePiProvider } from './piProvider'

const providerConfigSchema = z.object({
    provider: z.string().min(1), model: z.string().min(1), apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']).optional(),
    protocol: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']).optional(),
    headers: z.record(z.string(), z.string()).optional(), contextWindow: z.number().positive().optional(),
    maxTokens: z.number().positive().optional()
}).strict()

const providerRequestSchema = z.object({
    provider: z.discriminatedUnion('source', [
        z.object({ source: z.literal('default') }),
        z.object({ source: z.literal('credential'), credentialId: z.string().min(1) })
    ]),
    name: z.string().min(1), model: z.string().min(1), config: z.record(z.string(), z.unknown()).optional()
})

export async function runPi(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    model?: string
    effort?: string
    resumeSessionId?: string
} = {}): Promise<void> {
    const workingDirectory = getInvokedCwd()
    const startedBy = opts.startedBy ?? 'terminal'
    const startingMode = opts.startingMode ?? 'remote'
    const { api, session } = await bootstrapSession({ flavor: 'pi', startedBy, workingDirectory, agentState: { controlledByUser: false } })
    setControlledByUser(session, startingMode)
    let permissionMode = opts.permissionMode ?? 'default'
    let model = opts.model
    let effort = opts.effort
    const queue = new MessageQueue2<PiMode>((mode) => hashObject({ permissionMode: mode.permissionMode, model: mode.model, effort: mode.effort }))
    const ref: { current: PiSession | null } = { current: null }
    const providers: Array<() => Promise<void>> = []
    const lifecycle = createRunnerLifecycle({ session, logTag: 'pi', stopKeepAlive: () => ref.current?.stopKeepAlive(), onAfterClose: async () => {
        await Promise.all(providers.splice(0).map((dispose) => dispose().catch(() => {})))
    } })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit)

    session.onUserMessage((message) => {
        queue.push(formatMessageWithAttachments(message.content.text, message.content.attachments), {
            permissionMode, model, effort,
            appendSystemPrompt: typeof message.meta?.appendSystemPrompt === 'string' ? message.meta.appendSystemPrompt : undefined
        })
    })
    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
        if (value.permissionMode !== undefined) {
            const parsed = PermissionModeSchema.safeParse(value.permissionMode)
            if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'pi')) throw new Error('Invalid permission mode')
            permissionMode = parsed.data as PermissionMode
            ref.current?.setPermissionMode(permissionMode)
        }
        if (typeof value.modelMode === 'string' && value.modelMode.trim()) {
            model = value.modelMode === 'auto' ? undefined : value.modelMode.trim()
            ref.current?.setModelMode(model)
        }
        if (typeof value.effortMode === 'string') {
            effort = value.effortMode
            ref.current?.setEffortMode(effort)
        }
        ref.current?.publishRuntimeState()
        return { applied: { permissionMode, modelMode: model ?? 'auto', effortMode: effort ?? 'default' } }
    })
    session.rpcHandlerManager.registerHandler('set-session-provider', async (payload: unknown) => {
        const parsed = providerRequestSchema.safeParse(payload)
        if (!parsed.success) throw new Error('Invalid provider selection')
        const instance = ref.current
        if (!instance || instance.mode !== 'remote' || !instance.restartForProvider || instance.thinking || instance.providerChanging) {
            throw new Error('Provider switching requires an idle remote Pi session')
        }
        instance.providerChanging = true
        const previousEnv = instance.piEnv
        const previousModel = model
        let prepared: Awaited<ReturnType<typeof preparePiProvider>> | null = null
        try {
            const config = parsed.data.provider.source === 'default'
                ? undefined : providerConfigSchema.parse(parsed.data.config)
            prepared = await preparePiProvider(config as PiProviderConfig | undefined)
            instance.piEnv = prepared.env
            model = prepared.model ?? (parsed.data.model === 'auto' ? undefined : parsed.data.model)
            instance.setModelMode(model)
            await instance.restartForProvider()
            providers.push(prepared.dispose)
            session.updateMetadata((metadata) => ({ ...metadata, piProvider: { provider: parsed.data.provider, name: parsed.data.name } }))
            return { applied: { modelMode: model ?? 'auto' } }
        } catch {
            instance.piEnv = previousEnv
            model = previousModel
            instance.setModelMode(previousModel)
            await prepared?.dispose().catch(() => {})
            return { providerSwitchError: 'restart_failed' }
        } finally {
            instance.providerChanging = false
        }
    })

    try {
        await piLoop({ path: workingDirectory, startingMode, startedBy, onModeChange: createModeChangeHandler(session),
            messageQueue: queue, session, api, permissionMode, model, resumeSessionId: opts.resumeSessionId,
            onSessionReady: (instance) => { ref.current = instance }
        })
    } catch (error) {
        lifecycle.markCrash(error)
    } finally {
        await lifecycle.cleanupAndExit()
    }
}
