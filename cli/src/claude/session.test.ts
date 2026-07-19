import { describe, expect, it } from 'vitest';
import { consumeClaudeOneTimeArgs } from './session';

describe('consumeClaudeOneTimeArgs', () => {
    it('removes resume and fork flags after the first native fork', () => {
        expect(consumeClaudeOneTimeArgs([
            '--resume',
            '385098bf-6e80-4eec-b3a2-0e92b129513f',
            '--fork-session',
            '--dangerously-skip-permissions'
        ])).toEqual(['--dangerously-skip-permissions']);
    });
});
