/**
 * OpenCode configuration file generator.
 *
 * Generates opencode.json with shared HAPI agent instructions.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILENAME = 'opencode.json';
const INSTRUCTIONS_FILENAME = 'hapi-instructions.md';

interface OpencodeConfig {
    $schema: string;
    mcp?: Record<string, {
        type: string;
        command: string[];
        enabled: boolean;
    }>;
    instructions: string[];
}

/**
 * Ensures the opencode.json config file exists with MCP server and instructions.
 *
 * @param rootPath - The OPENCODE_CONFIG_DIR path
 * @param instructions - The instruction text to write to the instructions file
 */
export function ensureOpencodeConfig(
    rootPath: string,
    instructions: string
): { configPath: string; instructionsPath: string } {
    mkdirSync(rootPath, { recursive: true });

    // Write instructions file
    const instructionsPath = join(rootPath, INSTRUCTIONS_FILENAME);
    writeFileSafe(instructionsPath, instructions);

    // Build opencode.json config
    // Use absolute path for instructions since OpenCode resolves paths relative to project root
    const config: OpencodeConfig = {
        $schema: 'https://opencode.ai/config.json',
        instructions: [instructionsPath]
    };

    const configPath = join(rootPath, CONFIG_FILENAME);
    const configJson = JSON.stringify(config, null, 2);
    writeFileSafe(configPath, configJson);

    return { configPath, instructionsPath };
}

/**
 * Write file only if content has changed.
 */
function writeFileSafe(filePath: string, content: string): void {
    try {
        const current = readFileSync(filePath, 'utf-8');
        if (current === content) {
            return;
        }
    } catch {
        // Ignore missing or unreadable file
    }
    writeFileSync(filePath, content, 'utf-8');
}
