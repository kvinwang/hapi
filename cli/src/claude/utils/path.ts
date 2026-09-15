import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Mirrors Claude Code's project directory naming: long sanitized names are
// truncated and suffixed with a hash of the original path so they stay unique.
const MAX_PROJECT_ID_LENGTH = 200;

function hashPath(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    }
    return hash;
}

export function getProjectPath(workingDirectory: string) {
    const absolutePath = resolve(workingDirectory);
    const sanitized = absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
    const projectId = sanitized.length <= MAX_PROJECT_ID_LENGTH
        ? sanitized
        : `${sanitized.slice(0, MAX_PROJECT_ID_LENGTH)}-${Math.abs(hashPath(absolutePath)).toString(36)}`;
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}
