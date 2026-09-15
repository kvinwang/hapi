import { logger } from "@/ui/logger";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { getProjectPath } from "./path";

const READ_CHUNK_BYTES = 64 * 1024;

function hasMessageLine(line: string): boolean {
    try {
        return typeof JSON.parse(line).uuid === 'string';
    } catch {
        return false;
    }
}

/**
 * Whether Claude can resume `sessionId`: its transcript exists and holds at
 * least one conversation entry. Transcripts can be very large, so the file is
 * read in chunks only until the first entry is found.
 */
export function claudeCheckSession(sessionId: string, path: string) {
    const projectDir = getProjectPath(path);

    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    if (!existsSync(sessionFile)) {
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist`);
        return false;
    }

    let fd: number;
    try {
        fd = openSync(sessionFile, 'r');
    } catch (error) {
        logger.debug(`[claudeCheckSession] Failed to open ${sessionFile}:`, error);
        return false;
    }
    try {
        // Pieces of the current line; joined only once the line is complete so
        // a single huge entry is not re-copied for every chunk.
        let lineParts: Buffer[] = [];
        while (true) {
            const chunk = Buffer.alloc(READ_CHUNK_BYTES);
            const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
            if (bytesRead === 0) {
                return lineParts.length > 0 && hasMessageLine(Buffer.concat(lineParts).toString('utf-8'));
            }
            let start = 0;
            let newline: number;
            while ((newline = chunk.indexOf(0x0a, start)) !== -1 && newline < bytesRead) {
                lineParts.push(chunk.subarray(start, newline));
                const line = Buffer.concat(lineParts).toString('utf-8');
                lineParts = [];
                start = newline + 1;
                if (hasMessageLine(line)) {
                    return true;
                }
            }
            if (start < bytesRead) {
                lineParts.push(chunk.subarray(start, bytesRead));
            }
        }
    } finally {
        closeSync(fd);
    }
}
