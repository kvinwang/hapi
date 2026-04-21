import { describe, expect, it } from 'vitest';
import {
    buildMessageAppendSystemPrompt,
    buildStoredSystemPrompt,
    hapiSystemPrompt,
    joinPromptSections
} from './prompts';

describe('prompts', () => {
    it('joins prompt sections with blank lines', () => {
        expect(joinPromptSections('first', '', 'second')).toBe('first\n\nsecond');
    });

    it('builds stored prompt with global first, then session', () => {
        expect(buildStoredSystemPrompt({
            globalPrompt: 'global',
            sessionPrompt: 'session',
            includeGlobal: true
        })).toBe('global\n\nsession');
    });

    it('can skip global prompt when disabled', () => {
        expect(buildStoredSystemPrompt({
            globalPrompt: 'global',
            sessionPrompt: 'session',
            includeGlobal: false
        })).toBe('session');
    });

    it('always appends shared HAPI prompt for agent messages', () => {
        expect(buildMessageAppendSystemPrompt({
            globalPrompt: 'global',
            sessionPrompt: 'session',
            includeGlobal: true
        })).toBe(`global\n\nsession\n\n${hapiSystemPrompt}`);
    });

    it('falls back to HAPI prompt when DB prompts are empty', () => {
        expect(buildMessageAppendSystemPrompt({})).toBe(hapiSystemPrompt);
    });
});
