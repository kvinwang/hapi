import { EnhancedMode, PermissionMode } from "./loop";
import { query, type QueryOptions as Options, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import { getHapiBlobsDir } from "@/constants/uploadPaths";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import { joinPromptSections } from "@hapi/protocol/prompts";

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    initialMode: EnhancedMode,
    hookSettingsPath: string,
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: () => void | Promise<void>,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    onQueryReady?: (q: { interrupt: () => Promise<void>; getUsage: () => Promise<Record<string, unknown>> }) => void,
    onContextUsage?: (usage: Record<string, unknown>) => void
}): Promise<void> {

    // Keep query restarts (such as /clear) separate from the launcher's abort
    // signal. Reusing the latter would make the outer loop treat a normal
    // restart as a user-requested session abort.
    const queryAbortController = new AbortController();
    const abortQuery = () => queryAbortController.abort();
    const queryAbortSignal = opts.signal
        ? AbortSignal.any([opts.signal, queryAbortController.signal])
        : queryAbortController.signal;

    // Check if session is valid
    let startFrom = opts.sessionId;
    const forkSession = opts.claudeArgs?.includes('--fork-session') === true;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }
    process.env.DISABLE_AUTOUPDATER = '1';

    let isCompactCommand = false;

    // Prepare SDK options
    let mode = opts.initialMode;
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        forkSession,
        mcpServers: opts.mcpServers,
        permissionMode: mode.permissionMode,
        model: mode.model,
        fallbackModel: mode.fallbackModel,
        effort: mode.effort,
        customSystemPrompt: joinPromptSections(mode.customSystemPrompt, systemPrompt),
        appendSystemPrompt: mode.appendSystemPrompt ?? systemPrompt,
        allowedTools: mode.allowedTools ? mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        abort: queryAbortSignal,
        pathToClaudeCodeExecutable: getDefaultClaudeCodePath(),
        settingsPath: opts.hookSettingsPath,
        additionalDirectories: [getHapiBlobsDir()],
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    let messages = new PushableAsyncIterable<SDKUserMessage>();

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    const reportContextUsage = async () => {
        try {
            const contextUsage = await response.getContextUsage();
            opts.onContextUsage?.(contextUsage as Record<string, unknown>);
        } catch (error) {
            logger.debug('[claudeRemote] Failed to read context usage:', error);
        }
    };

    // Initialize the stream-json control plane immediately. Claude otherwise
    // waits for the first user message before making context and usage RPCs
    // available, which makes a revived session only superficially active.
    await response.initialize();
    await reportContextUsage();

    // Expose controls only after initialization succeeds.
    opts.onQueryReady?.({
        interrupt: () => response.interrupt(),
        getUsage: () => response.getUsage() as Promise<Record<string, unknown>>
    });

    const inputPump = (async () => {
        try {
            while (true) {
                const next = await opts.nextMessage();
                if (!next) break;
                const specialCommand = parseSpecialCommand(next.message);
                if (specialCommand.type === 'clear') {
                    opts.onCompletionEvent?.('Context was reset');
                    opts.onSessionReset?.();
                    // Ending stdin alone does not reliably terminate a resumed
                    // Claude stream. Abort this query so the outer launcher can
                    // immediately start a fresh, empty-context query.
                    abortQuery();
                    break;
                }
                if (specialCommand.type === 'compact') {
                    logger.debug('[claudeRemote] /compact command detected');
                    isCompactCommand = true;
                    opts.onCompletionEvent?.('Compaction started');
                }
                mode = next.mode;
                updateThinking(true);
                messages.push({ type: 'user', message: { role: 'user', content: next.message } });
            }
        } catch (error) {
            if (!(error instanceof AbortError)) throw error;
        } finally {
            messages.end();
        }
    })();
    void inputPump.catch((error) => logger.debug('[claudeRemote] Input pump failed:', error));

    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        // Use manual iterator so we can race SDK output against user input.
        // A `for await` loop would block at `nextMessage()` and prevent
        // reading SDK messages when the SDK auto-continues (context management).
        const iterator = response[Symbol.asyncIterator]();
        while (true) {
            const iterResult = await iterator.next();
            if (iterResult.done) break;

            const message = iterResult.value;
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            // Handle messages — replayed messages during --resume are deduplicated
            // by the hub using the SDK's stable message UUID as localId.
            opts.onMessage(message);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
                await reportContextUsage();
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received');

                await reportContextUsage();

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Send ready event
                await opts.onReady();

            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
        } else {
            throw e;
        }
    } finally {
        updateThinking(false);
        // Ensure the stdin stream is closed so the spawned Claude process
        // can terminate.  Without this, early exits (e.g. tool-abort) leave
        // the child process alive and block the next --resume iteration.
        messages.end();
    }
}
