import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCheckSession } from './claudeCheckSession';
import { getProjectPath } from './path';

const WORKDIR = '/work/check-session';
const SESSION = '55555555-5555-4555-8555-555555555555';

describe('claudeCheckSession', () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    let configDir: string;

    const write = (content: string) => {
        writeFileSync(join(getProjectPath(WORKDIR), `${SESSION}.jsonl`), content);
    };

    beforeEach(() => {
        configDir = mkdtempSync(join(tmpdir(), 'hapi-check-session-'));
        process.env.CLAUDE_CONFIG_DIR = configDir;
        mkdirSync(getProjectPath(WORKDIR), { recursive: true });
    });

    afterEach(() => {
        rmSync(configDir, { recursive: true, force: true });
        if (originalConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
        }
    });

    it('rejects a missing transcript', () => {
        expect(claudeCheckSession(SESSION, WORKDIR)).toBe(false);
    });

    it('rejects a transcript without conversation entries', () => {
        write(`${JSON.stringify({ type: 'summary' })}\nnot json\n`);
        expect(claudeCheckSession(SESSION, WORKDIR)).toBe(false);
    });

    it('accepts an entry that spans read chunks', () => {
        const padding = 'x'.repeat(100 * 1024);
        write(`${JSON.stringify({ type: 'summary', padding })}\n${JSON.stringify({ type: 'user', uuid: 'u1', padding })}\n`);
        expect(claudeCheckSession(SESSION, WORKDIR)).toBe(true);
    });

    it('accepts a final entry without a trailing newline', () => {
        write(JSON.stringify({ type: 'user', uuid: 'u1' }));
        expect(claudeCheckSession(SESSION, WORKDIR)).toBe(true);
    });
});
