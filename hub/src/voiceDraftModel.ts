import { z } from 'zod'
import type { CredentialConfig, ModelProtocol } from '@hapi/protocol'

/** One entry of the voice draft conversation, in the Omni realtime item shape the browser keeps. */
export const VoiceDraftItemSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('message'), text: z.string() }),
    z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(), arguments: z.string() }),
    z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.string() })
])
export type VoiceDraftItem = z.infer<typeof VoiceDraftItemSchema>

export const VoiceDraftToolSchema = z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string(), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()) })
})
export type VoiceDraftTool = z.infer<typeof VoiceDraftToolSchema>

export type VoiceDraftCall = { call_id: string; name: string; arguments: string }

const TIMEOUT_MS = 60_000

function pickProtocol(config: CredentialConfig, model: string): ModelProtocol | undefined {
    const order: ModelProtocol[] = /claude|anthropic/i.test(model)
        ? ['anthropic-messages', 'openai-responses', 'openai-completions']
        : ['openai-responses', 'openai-completions', 'anthropic-messages']
    return order.find((protocol) => config.endpoints[protocol])
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`)
    return JSON.parse(text) as Record<string, unknown>
}

/** Adjacent items of one role share a message: the Anthropic and Chat Completions APIs expect turns to alternate. */
function groupByRole<T>(items: VoiceDraftItem[], role: (item: VoiceDraftItem) => string, render: (item: VoiceDraftItem) => T): Array<{ role: string; parts: T[] }> {
    const groups: Array<{ role: string; parts: T[] }> = []
    for (const item of items) {
        const last = groups.at(-1)
        if (last?.role === role(item)) last.parts.push(render(item))
        else groups.push({ role: role(item), parts: [render(item)] })
    }
    return groups
}

async function anthropic(base: string, config: CredentialConfig, model: string, instructions: string, items: VoiceDraftItem[], tools: VoiceDraftTool[]): Promise<VoiceDraftCall[]> {
    const messages = groupByRole(items, (item) => item.type === 'function_call' ? 'assistant' : 'user', (item) =>
        item.type === 'message' ? { type: 'text', text: item.text }
            : item.type === 'function_call' ? { type: 'tool_use', id: item.call_id, name: item.name, input: JSON.parse(item.arguments || '{}') }
                : { type: 'tool_result', tool_use_id: item.call_id, content: item.output }
    ).map(({ role, parts }) => ({ role, content: parts }))
    const result = await post(`${base}/v1/messages`, { ...config.headers, authorization: `Bearer ${config.apiKey}`, 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }, {
        model,
        max_tokens: 4096,
        system: instructions,
        messages,
        tools: tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description, input_schema: fn.parameters })),
        tool_choice: { type: 'auto' }
    })
    return (result.content as Array<{ type: string; id: string; name: string; input: unknown }> ?? [])
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) }))
}

async function responses(base: string, config: CredentialConfig, model: string, instructions: string, items: VoiceDraftItem[], tools: VoiceDraftTool[]): Promise<VoiceDraftCall[]> {
    const result = await post(`${base}/responses`, { ...config.headers, authorization: `Bearer ${config.apiKey}` }, {
        model,
        instructions,
        input: items.map((item) => item.type === 'message' ? { role: 'user', content: item.text } : item),
        tools: tools.map(({ function: fn }) => ({ type: 'function', ...fn })),
        tool_choice: 'required',
        store: false
    })
    return (result.output as Array<VoiceDraftCall & { type: string }> ?? [])
        .filter((item) => item.type === 'function_call')
        .map(({ call_id, name, arguments: args }) => ({ call_id, name, arguments: args }))
}

async function completions(base: string, config: CredentialConfig, model: string, instructions: string, items: VoiceDraftItem[], tools: VoiceDraftTool[]): Promise<VoiceDraftCall[]> {
    const calls = (group: VoiceDraftItem[]) => group.flatMap((item) => item.type === 'function_call'
        ? [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] : [])
    const messages: unknown[] = [{ role: 'system', content: instructions }]
    for (const { role, parts } of groupByRole(items, (item) => item.type, (item) => item)) {
        if (role === 'function_call') messages.push({ role: 'assistant', content: null, tool_calls: calls(parts) })
        else messages.push(...parts.map((item) => item.type === 'function_call_output'
            ? { role: 'tool', tool_call_id: item.call_id, content: item.output }
            : { role: 'user', content: item.type === 'message' ? item.text : '' }))
    }
    const result = await post(`${base}/chat/completions`, { ...config.headers, authorization: `Bearer ${config.apiKey}` }, {
        model, messages, tools, tool_choice: 'required'
    })
    const toolCalls = (result.choices as Array<{ message?: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> | undefined)?.[0]?.message?.tool_calls ?? []
    return toolCalls.map((call) => ({ call_id: call.id, name: call.function.name, arguments: call.function.arguments }))
}

/** Runs one voice draft turn on a provider model: the tool calls it makes, as Omni would have made them. */
export async function runVoiceDraftModel(config: CredentialConfig, model: string, instructions: string, items: VoiceDraftItem[], tools: VoiceDraftTool[]): Promise<VoiceDraftCall[]> {
    const protocol = pickProtocol(config, model)
    const base = protocol && config.endpoints[protocol]!.replace(/\/+$/, '')
    if (!protocol || !base) throw new Error('Provider has no supported endpoint')
    const run = protocol === 'anthropic-messages' ? anthropic : protocol === 'openai-responses' ? responses : completions
    return await run(base, config, model, instructions, items, tools)
}
