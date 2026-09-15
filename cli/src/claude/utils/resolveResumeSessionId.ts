import { logger } from "@/ui/logger";
import { claudeCheckSession } from "./claudeCheckSession";

/**
 * Extract the session ID of a `--resume <id>` flag. Returns null when the flag
 * is absent or has no ID (remote mode cannot show Claude's session picker).
 */
export function findClaudeResumeArg(args: string[] | undefined): string | null {
    if (!args) return null;
    const index = args.indexOf('--resume');
    if (index === -1) return null;
    const nextArg = args[index + 1];
    // A session ID never starts with a dash and always contains one.
    if (nextArg && !nextArg.startsWith('-') && nextArg.includes('-')) {
        return nextArg;
    }
    return null;
}

/**
 * Pick the Claude conversation to resume, if any.
 *
 * Claude only writes a transcript once the conversation has a message, yet it
 * reports the session ID as soon as it starts. An ID captured in that window
 * (e.g. a /clear followed by a kill) has nothing to resume, and passing it to
 * Claude makes it exit with "No conversation found". Every candidate is
 * therefore checked against the transcript on disk; a missing one falls back
 * to a fresh conversation.
 */
export function resolveResumeSessionId(opts: {
    sessionId: string | null;
    claudeArgs?: string[];
    path: string;
}): string | null {
    const candidates: Array<[string, string | null]> = [
        ['current session', opts.sessionId],
        ['--resume flag', findClaudeResumeArg(opts.claudeArgs)]
    ];
    for (const [source, sessionId] of candidates) {
        if (!sessionId) continue;
        if (claudeCheckSession(sessionId, opts.path)) {
            return sessionId;
        }
        logger.debug(`[resolveResumeSessionId] Ignoring ${source} ${sessionId}: no transcript with messages`);
    }
    return null;
}
