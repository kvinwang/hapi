import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function findSessionFile(dir: string, sessionId: string): Promise<string | undefined> {
    const suffix = `-${sessionId}.jsonl`;
    try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isFile() && entry.name.endsWith(suffix)) return path;
            if (entry.isDirectory()) {
                const found = await findSessionFile(path, sessionId);
                if (found) return found;
            }
        }
    } catch {
        // Missing/unreadable session directory.
    }
    return undefined;
}

export async function findLastCompletedTurnAt(
    sessionId: string,
    forkAtTimestamp: string,
    codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
): Promise<string | undefined> {
    const sourceFile = await findSessionFile(join(codexHome, 'sessions'), sessionId);
    if (!sourceFile) throw new Error(`Codex session file not found for ${sessionId}`);

    let lastTurnId: string | undefined;
    for (const line of (await readFile(sourceFile, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line) as {
                timestamp?: unknown;
                type?: unknown;
                payload?: { type?: unknown; turn_id?: unknown };
            };
            if (typeof event.timestamp !== 'string' || event.timestamp > forkAtTimestamp) continue;
            if (event.type === 'event_msg' && event.payload?.type === 'task_complete'
                && typeof event.payload.turn_id === 'string') {
                lastTurnId = event.payload.turn_id;
            }
        } catch {
            // Ignore malformed rollout lines.
        }
    }
    return lastTurnId;
}
