import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { credentialProtocolFor, type CredentialAgent, type CredentialConfig } from '@hapi/protocol'
import type { TomlTable } from 'smol-toml'

function endpointFor(config: CredentialConfig, agent: CredentialAgent) {
    const protocol = credentialProtocolFor(config, agent)
    if (!protocol) throw new Error(`Credential has no endpoint compatible with ${agent}`)
    return { protocol, baseUrl: config.endpoints[protocol]! }
}

/** Top-level Codex config keys owned by a credential; the catalog path is filled in by the caller. */
export function codexConfig(config: CredentialConfig, model = config.defaultModel): TomlTable {
    const { baseUrl } = endpointFor(config, 'codex')
    return {
        model,
        model_provider: config.provider,
        model_providers: {
            [config.provider]: {
                name: config.provider,
                base_url: baseUrl,
                wire_api: 'responses',
                requires_openai_auth: false,
                experimental_bearer_token: config.apiKey,
                ...(config.headers ? { http_headers: config.headers } : {})
            }
        }
    }
}

/**
 * Codex requires full model metadata; borrow it from the catalog bundled with the installed Codex,
 * minus tool shapes only OpenAI serves (freeform apply_patch, code-mode namespaces, Responses Lite).
 */
async function codexModelTemplate(): Promise<Record<string, unknown>> {
    const home = await mkdtemp(join(tmpdir(), 'hapi-codex-catalog-'))
    try {
        const { stdout } = await promisify(execFile)('codex', ['debug', 'models'], {
            env: { ...process.env, CODEX_HOME: home },
            maxBuffer: 64 * 1024 * 1024,
            timeout: 30_000
        })
        const models = (JSON.parse(stdout) as { models?: Array<Record<string, unknown>> }).models ?? []
        const template = models.find((model) => model.visibility === 'list') ?? models[0]
        if (!template) throw new Error('empty catalog')
        const { tool_mode: _toolMode, multi_agent_version: _agents, multi_agent_reasoning_effort: _effort, ...generic } = template
        return {
            ...generic,
            apply_patch_tool_type: null,
            use_responses_lite: false,
            experimental_supported_tools: [],
            supports_experimental_context: false
        }
    } catch {
        throw new Error('Unable to read the bundled Codex model catalog; is codex installed?')
    } finally {
        await rm(home, { recursive: true, force: true })
    }
}

export async function codexModelCatalog(config: CredentialConfig): Promise<{ models: Array<Record<string, unknown>> }> {
    const template = await codexModelTemplate()
    return {
        models: config.models.map((model, priority) => ({
            ...template,
            slug: model.id,
            display_name: model.name ?? model.id,
            description: '',
            priority,
            visibility: 'list',
            upgrade: null,
            availability_nux: null,
            service_tiers: [],
            additional_speed_tiers: [],
            ...(model.contextWindow ? { context_window: model.contextWindow, max_context_window: model.contextWindow } : {})
        }))
    }
}

export const CLAUDE_CREDENTIAL_ENV_KEYS = [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_MODEL', 'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_USE_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_PROFILE',
    'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
    'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
    'CLAUDE_CODE_USE_FOUNDRY'
]

/** Settings keys for Claude Code: every model alias maps to the default so background calls stay on this provider. */
export function claudeSettings(config: CredentialConfig): { env: Record<string, string>; modelPicker: unknown } {
    const { baseUrl } = endpointFor(config, 'claude')
    const model = config.defaultModel
    return {
        env: {
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_AUTH_TOKEN: config.apiKey,
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            ...(config.headers ? {
                ANTHROPIC_CUSTOM_HEADERS: Object.entries(config.headers).map(([name, value]) => `${name}: ${value}`).join('\n')
            } : {})
        },
        modelPicker: {
            options: config.models.map((entry) => ({ model: entry.id, label: entry.name ?? entry.id })),
            replaceBuiltInOptions: true
        }
    }
}

export function piProvider(config: CredentialConfig): Record<string, unknown> {
    const { protocol, baseUrl } = endpointFor(config, 'pi')
    return {
        baseUrl,
        api: protocol,
        apiKey: config.apiKey,
        ...(config.headers ? { headers: config.headers } : {}),
        models: config.models
    }
}
