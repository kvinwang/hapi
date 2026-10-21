import { z } from 'zod'

export const MODEL_PROTOCOLS = ['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai'] as const
export const ModelProtocolSchema = z.enum(MODEL_PROTOCOLS)
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>

export const CredentialModelSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional()
}).strict()
export type CredentialModel = z.infer<typeof CredentialModelSchema>

export const CredentialEndpointsSchema = z.partialRecord(ModelProtocolSchema, z.url())
    .refine((endpoints) => Object.keys(endpoints).length > 0, 'At least one endpoint is required')

/** Agent-neutral API credential; adapters render it into each agent CLI's native configuration. */
export const CredentialConfigSchema = z.object({
    provider: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Provider ID may only contain letters, digits, "_" and "-"'),
    apiKey: z.string().min(1),
    endpoints: CredentialEndpointsSchema,
    headers: z.record(z.string(), z.string()).optional(),
    models: z.array(CredentialModelSchema).min(1),
    defaultModel: z.string().trim().min(1),
    /** Hub mirrors the upstream model list hourly, keeping local edits to models that remain. */
    autoSyncModels: z.boolean().optional()
}).strict().refine((config) => config.models.some((model) => model.id === config.defaultModel), {
    message: 'Default model must be in the model list',
    path: ['defaultModel']
})
export type CredentialConfig = z.infer<typeof CredentialConfigSchema>

/** Agents whose machine-wide configuration can be written by an applied credential. */
export const CREDENTIAL_AGENTS = ['claude', 'codex', 'pi'] as const
export const CredentialAgentSchema = z.enum(CREDENTIAL_AGENTS)
export type CredentialAgent = z.infer<typeof CredentialAgentSchema>

/** Agents that can run a single session against a credential without changing machine configuration. */
export const SESSION_CREDENTIAL_AGENTS = [...CREDENTIAL_AGENTS, 'gemini', 'opencode'] as const
export const SessionCredentialAgentSchema = z.enum(SESSION_CREDENTIAL_AGENTS)
export type SessionCredentialAgent = z.infer<typeof SessionCredentialAgentSchema>

export function isSessionCredentialAgent(value: string): value is SessionCredentialAgent {
    return (SESSION_CREDENTIAL_AGENTS as readonly string[]).includes(value)
}

/** Protocols each agent can speak, in order of preference. */
const AGENT_PROTOCOLS: Record<SessionCredentialAgent, readonly ModelProtocol[]> = {
    claude: ['anthropic-messages'],
    codex: ['openai-responses'],
    pi: MODEL_PROTOCOLS,
    gemini: ['google-generative-ai'],
    opencode: MODEL_PROTOCOLS
}

export function credentialProtocolFor(
    config: Pick<CredentialConfig, 'endpoints'>,
    agent: SessionCredentialAgent
): ModelProtocol | undefined {
    return AGENT_PROTOCOLS[agent].find((protocol) => config.endpoints[protocol])
}

export function compatibleCredentialAgents(config: Pick<CredentialConfig, 'endpoints'>): CredentialAgent[] {
    return CREDENTIAL_AGENTS.filter((agent) => credentialProtocolFor(config, agent))
}
