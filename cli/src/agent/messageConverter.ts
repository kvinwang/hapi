import type { AgentMessage, PlanItem } from './types';

export type CodexMessage =
    | { type: 'message'; message: string; usage?: CodexUsage; model?: string }
    | {
        type: 'tool-call';
        name: string;
        callId: string;
        input: unknown;
        status?: 'pending' | 'in_progress' | 'completed' | 'failed';
    }
    | {
        type: 'tool-call-result';
        callId: string;
        output: unknown;
        is_error?: boolean;
    }
    | { type: 'plan'; entries: PlanItem[] }
    | { type: 'error'; message: string }
    | {
        type: 'usage';
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        model?: string;
    };

export type CodexUsage = {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
};

export function convertAgentMessage(message: AgentMessage): CodexMessage | null {
    switch (message.type) {
        case 'text':
            return { type: 'message', message: message.text };
        case 'tool_call':
            return {
                type: 'tool-call',
                name: message.name,
                callId: message.id,
                input: message.input,
                status: message.status
            };
        case 'tool_result':
            return {
                type: 'tool-call-result',
                callId: message.id,
                output: message.output,
                is_error: message.status === 'failed'
            };
        case 'plan':
            return {
                type: 'plan',
                entries: message.items
            };
        case 'error':
            return { type: 'error', message: message.message };
        case 'turn_complete':
            if (!message.usage) {
                return null;
            }
            // Prefer totalTokens as context occupancy. When using it, skip cache
            // breakdown so the web status bar does not double-count.
            if (message.usage.totalTokens != null) {
                return {
                    type: 'usage',
                    input_tokens: message.usage.totalTokens,
                    output_tokens: message.usage.outputTokens,
                    model: message.usage.modelId
                };
            }
            return {
                type: 'usage',
                input_tokens: message.usage.inputTokens,
                output_tokens: message.usage.outputTokens,
                cache_read_input_tokens: message.usage.cacheReadTokens,
                cache_creation_input_tokens: message.usage.cacheCreationTokens,
                model: message.usage.modelId
            };
        default: {
            const _exhaustive: never = message;
            return _exhaustive;
        }
    }
}
