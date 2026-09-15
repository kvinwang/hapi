import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectPath } from './path';
import { findClaudeResumeArg, resolveResumeSessionId } from './resolveResumeSessionId';

const WORKDIR = '/work/project';
const VALID = '11111111-1111-4111-8111-111111111111';
const EMPTY = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';

describe('findClaudeResumeArg', () => {
    it('returns the session ID following --resume', () => {
        expect(findClaudeResumeArg(['--resume', VALID, '--fork-session'])).toBe(VALID);
    });

    it('ignores a bare --resume flag', () => {
        expect(findClaudeResumeArg(['--resume', '--yolo'])).toBeNull();
        expect(findClaudeResumeArg(['--resume'])).toBeNull();
        expect(findClaudeResumeArg(undefined)).toBeNull();
    });
});

describe('resolveResumeSessionId', () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    let configDir: string;

    beforeEach(() => {
        configDir = mkdtempSync(join(tmpdir(), 'hapi-resume-'));
        process.env.CLAUDE_CONFIG_DIR = configDir;
        const projectDir = getProjectPath(WORKDIR);
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, `${VALID}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'u1' })}\n`);
        // Claude can leave a transcript without any conversation entry.
        writeFileSync(join(projectDir, `${EMPTY}.jsonl`), `${JSON.stringify({ type: 'summary' })}\n`);
    });

    afterEach(() => {
        rmSync(configDir, { recursive: true, force: true });
        if (originalConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
        }
    });

    it('resumes the current session when its transcript exists', () => {
        expect(resolveResumeSessionId({ sessionId: VALID, claudeArgs: ['--resume', MISSING], path: WORKDIR })).toBe(VALID);
    });

    it('starts fresh when the --resume ID has no transcript', () => {
        expect(resolveResumeSessionId({ sessionId: null, claudeArgs: ['--resume', MISSING], path: WORKDIR })).toBeNull();
    });

    it('starts fresh when the transcript has no messages', () => {
        expect(resolveResumeSessionId({ sessionId: EMPTY, claudeArgs: ['--resume', EMPTY], path: WORKDIR })).toBeNull();
    });

    it('falls back to the --resume ID when the current session is unusable', () => {
        expect(resolveResumeSessionId({ sessionId: MISSING, claudeArgs: ['--resume', VALID], path: WORKDIR })).toBe(VALID);
    });
});
