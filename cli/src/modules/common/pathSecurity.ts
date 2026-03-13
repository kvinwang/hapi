import { resolve, sep, isAbsolute } from 'path';
import { stat } from 'fs/promises';

export interface PathValidationResult {
    valid: boolean;
    error?: string;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    // Resolve both paths to absolute paths to handle path traversal attempts
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);

    // Check if the resolved target path starts with the working directory
    // This prevents access to files outside the working directory
    const normalizedTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget
    const normalizedWorkingDir = process.platform === 'win32' ? resolvedWorkingDir.toLowerCase() : resolvedWorkingDir
    const workingDirPrefix = normalizedWorkingDir.endsWith(sep) ? normalizedWorkingDir : normalizedWorkingDir + sep

    if (normalizedTarget !== normalizedWorkingDir && !normalizedTarget.startsWith(workingDirPrefix)) {
        return {
            valid: false,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    return { valid: true };
}

/**
 * Validates that a cwd override is an absolute path and exists as a directory.
 * Unlike validatePath, this does NOT restrict to a parent working directory —
 * the authenticated user is trusted to browse any directory on the machine.
 */
export async function validateCwd(cwd: string): Promise<PathValidationResult> {
    if (!isAbsolute(cwd)) {
        return { valid: false, error: `cwd must be an absolute path: '${cwd}'` };
    }
    try {
        const stats = await stat(cwd);
        if (!stats.isDirectory()) {
            return { valid: false, error: `cwd is not a directory: '${cwd}'` };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: `cwd does not exist: '${cwd}'` };
    }
}
