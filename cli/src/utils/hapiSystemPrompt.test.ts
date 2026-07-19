import { describe, expect, it } from 'vitest';
import { hapiSystemPrompt } from './hapiSystemPrompt';

describe('hapiSystemPrompt', () => {
    it('uses unified CLI title instructions', () => {
        expect(hapiSystemPrompt).toContain('hapi session set-summary');
        expect(hapiSystemPrompt).not.toContain('hapi session set-title');
        expect(hapiSystemPrompt).toContain('HAPI_SESSION_ID');
        expect(hapiSystemPrompt).not.toContain('change_title');
        expect(hapiSystemPrompt).not.toContain('Co-Authored-By');
    });

    it('uses unified CLI upload instructions', () => {
        expect(hapiSystemPrompt).toContain('hapi upload --name');
        expect(hapiSystemPrompt).toContain('This command prints a URL.');
        expect(hapiSystemPrompt).not.toContain('upload_file');
    });
});
