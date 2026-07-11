import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

export const GROK_MODEL_ENV = 'GROK_MODEL';
export const XAI_API_KEY_ENV = 'XAI_API_KEY';
export const DEFAULT_GROK_MODEL = 'grok-4.5';

export type GrokLocalConfig = {
    model?: string;
};

const GROK_DIR = join(homedir(), '.grok');
const CONFIG_PATH = join(GROK_DIR, 'config.toml');
const MODELS_CACHE_PATH = join(GROK_DIR, 'models_cache.json');

function readDefaultModelFromToml(raw: string): string | undefined {
    // Minimal parse: look for model = "..." under [cli] or top-level.
    const modelMatch = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    if (modelMatch?.[1]?.trim()) {
        return modelMatch[1].trim();
    }
    return undefined;
}

function readDefaultModelFromCache(): string | undefined {
    if (!existsSync(MODELS_CACHE_PATH)) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(readFileSync(MODELS_CACHE_PATH, 'utf-8')) as {
            models?: Record<string, unknown>;
        };
        if (parsed.models && typeof parsed.models === 'object') {
            if (DEFAULT_GROK_MODEL in parsed.models) {
                return DEFAULT_GROK_MODEL;
            }
            const first = Object.keys(parsed.models)[0];
            if (first) {
                return first;
            }
        }
    } catch (error) {
        logger.debug(`[grok-config] Failed to read models cache: ${error}`);
    }
    return undefined;
}

export function readGrokLocalConfig(): GrokLocalConfig {
    let model: string | undefined;
    if (existsSync(CONFIG_PATH)) {
        try {
            model = readDefaultModelFromToml(readFileSync(CONFIG_PATH, 'utf-8'));
        } catch (error) {
            logger.debug(`[grok-config] Failed to read ${CONFIG_PATH}: ${error}`);
        }
    }
    if (!model) {
        model = readDefaultModelFromCache();
    }
    return { model };
}

export function resolveGrokRuntimeConfig(opts: {
    model?: string;
} = {}): { model: string } {
    const local = readGrokLocalConfig();
    const model = opts.model
        ?? process.env[GROK_MODEL_ENV]
        ?? local.model
        ?? DEFAULT_GROK_MODEL;
    return { model };
}

export function buildGrokEnv(opts: {
    model?: string;
    cwd?: string;
}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env
    };
    if (opts.model) {
        env[GROK_MODEL_ENV] = opts.model;
    }
    if (opts.cwd) {
        env.GROK_CWD = opts.cwd;
    }
    return env;
}
