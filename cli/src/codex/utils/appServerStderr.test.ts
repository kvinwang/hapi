import { describe, expect, it } from 'vitest';
import { extractAppServerTurnError } from './appServerStderr';

describe('extractAppServerTurnError', () => {
    it('extracts a turn failure from app-server stderr', () => {
        expect(extractAppServerTurnError(
            '2026-07-19T10:42:25Z ERROR codex_core::session::turn: Failed to run pre-sampling compact'
        )).toBe('Failed to run pre-sampling compact');
    });

    it('ignores unrelated tool errors', () => {
        expect(extractAppServerTurnError(
            '2026-07-19T10:42:25Z ERROR codex_core::tools::router: apply_patch failed'
        )).toBeNull();
    });
});
