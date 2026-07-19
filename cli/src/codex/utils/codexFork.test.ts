import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findLastCompletedTurnAt } from './codexFork';

describe('findLastCompletedTurnAt', () => {
    const dirs: string[] = [];
    afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

    it('returns the last completed turn at the fork timestamp', async () => {
        const home = await mkdtemp(join(tmpdir(), 'codex-fork-'));
        dirs.push(home);
        const dir = join(home, 'sessions', '2026', '01', '02');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'rollout-test-source.jsonl'), [
            JSON.stringify({ timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
            JSON.stringify({ timestamp: '2026-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } })
        ].join('\n'));

        await expect(findLastCompletedTurnAt('source', '2026-01-01T00:00:02Z', home)).resolves.toBe('turn-1');
    });
});
