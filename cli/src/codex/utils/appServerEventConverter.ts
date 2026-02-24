import { logger } from '@/ui/logger';

type ConvertedEvent = {
    type: string;
    [key: string]: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractItemId(params: Record<string, unknown>): string | null {
    const direct = asString(params.itemId ?? params.item_id ?? params.id);
    if (direct) return direct;

    const item = asRecord(params.item);
    if (item) {
        return asString(item.id ?? item.itemId ?? item.item_id);
    }

    return null;
}

function extractItem(params: Record<string, unknown>): Record<string, unknown> | null {
    const item = asRecord(params.item);
    return item ?? params;
}

function normalizeItemType(value: unknown): string | null {
    const raw = asString(value);
    if (!raw) return null;
    return raw.toLowerCase().replace(/[\s_-]/g, '');
}

function extractCommand(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        const shellWrapped = trimmed.match(/^(?:\/bin\/)?(?:ba)?sh\s+-l?c\s+([\s\S]+)$/);
        if (shellWrapped && typeof shellWrapped[1] === 'string' && shellWrapped[1].trim().length > 0) {
            return shellWrapped[1].trim();
        }
        return value;
    }
    if (Array.isArray(value)) {
        const parts = value.filter((part): part is string => typeof part === 'string');
        if (parts.length >= 3 && /(?:^|\/)(?:ba)?sh$/.test(parts[0]) && (parts[1] === '-lc' || parts[1] === '-c')) {
            return parts[2] ?? null;
        }
        return parts.length > 0 ? parts.join(' ') : null;
    }
    return null;
}

function extractChanges(value: unknown): Record<string, unknown> | null {
    const record = asRecord(value);
    if (record) return record;

    if (Array.isArray(value)) {
        const changes: Record<string, unknown> = {};
        for (const entry of value) {
            const entryRecord = asRecord(entry);
            if (!entryRecord) continue;
            const path = asString(entryRecord.path ?? entryRecord.file ?? entryRecord.filePath ?? entryRecord.file_path);
            if (path) {
                changes[path] = entryRecord;
            }
        }
        return Object.keys(changes).length > 0 ? changes : null;
    }

    return null;
}

function extractTextContent(value: unknown, depth: number = 0): string | undefined {
    if (depth > 3 || value === null || value === undefined) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    if (Array.isArray(value)) {
        const parts = value
            .map((entry) => extractTextContent(entry, depth + 1))
            .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
        if (parts.length > 0) {
            return parts.join('\n');
        }
        return undefined;
    }

    const record = asRecord(value);
    if (!record) return undefined;

    const direct = asString(record.text ?? record.output ?? record.stdout ?? record.formatted_output ?? record.aggregated_output ?? record.message);
    if (direct) return direct;

    const nested = extractTextContent(record.content ?? record.result ?? record.data, depth + 1);
    if (nested) return nested;

    return undefined;
}

function extractCommandOutput(value: unknown): { output?: string; stdout?: string; stderr?: string; outputRaw?: Record<string, unknown> } {
    const outputRaw = asRecord(value) ?? undefined;
    const output = extractTextContent(value);
    const stdout = asString(outputRaw?.stdout) ?? undefined;
    const stderr = asString(outputRaw?.stderr) ?? undefined;
    return { output, stdout, stderr, outputRaw };
}

export class AppServerEventConverter {
    private readonly agentMessageBuffers = new Map<string, string>();
    private readonly reasoningBuffers = new Map<string, string>();
    private readonly commandOutputBuffers = new Map<string, string>();
    private readonly commandMeta = new Map<string, Record<string, unknown>>();
    private readonly fileChangeMeta = new Map<string, Record<string, unknown>>();
    private readonly wrappedCommandIds = new Set<string>();

    handleNotification(method: string, params: unknown): ConvertedEvent[] {
        if (method.startsWith('codex/event/')) {
            const paramsRecord = asRecord(params) ?? {};
            const msg = asRecord(paramsRecord.msg);
            if (msg) {
                const msgType = asString(msg.type);
                if (msgType) {
                    return this.handleCodexWrappedEvent(msgType, msg);
                }
            }
            return [];
        }

        const events: ConvertedEvent[] = [];
        const paramsRecord = asRecord(params) ?? {};

        if (method === 'thread/started' || method === 'thread/resumed') {
            const thread = asRecord(paramsRecord.thread) ?? paramsRecord;
            const threadId = asString(thread.threadId ?? thread.thread_id ?? thread.id);
            if (threadId) {
                events.push({ type: 'thread_started', thread_id: threadId });
            }
            return events;
        }

        if (method === 'turn/started') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);
            events.push({ type: 'task_started', ...(turnId ? { turn_id: turnId } : {}) });
            return events;
        }

        if (method === 'turn/completed') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const statusRaw = asString(paramsRecord.status ?? turn.status);
            const status = statusRaw?.toLowerCase();
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);
            const errorMessage = asString(paramsRecord.error ?? paramsRecord.message ?? paramsRecord.reason);

            if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') {
                events.push({ type: 'turn_aborted', ...(turnId ? { turn_id: turnId } : {}) });
                return events;
            }

            if (status === 'failed' || status === 'error') {
                events.push({ type: 'task_failed', ...(turnId ? { turn_id: turnId } : {}), ...(errorMessage ? { error: errorMessage } : {}) });
                return events;
            }

            events.push({ type: 'task_complete', ...(turnId ? { turn_id: turnId } : {}) });
            return events;
        }

        if (method === 'turn/diff/updated') {
            const diff = asString(paramsRecord.diff ?? paramsRecord.unified_diff ?? paramsRecord.unifiedDiff);
            if (diff) {
                events.push({ type: 'turn_diff', unified_diff: diff });
            }
            return events;
        }

        if (method === 'thread/tokenUsage/updated') {
            const info = asRecord(paramsRecord.tokenUsage ?? paramsRecord.token_usage ?? paramsRecord) ?? {};
            events.push({ type: 'token_count', info });
            return events;
        }

        if (method === 'error') {
            const willRetry = asBoolean(paramsRecord.will_retry ?? paramsRecord.willRetry) ?? false;
            if (willRetry) return events;
            const message = asString(paramsRecord.message) ?? asString(asRecord(paramsRecord.error)?.message);
            if (message) {
                events.push({ type: 'task_failed', error: message });
            }
            return events;
        }

        if (method === 'item/agentMessage/delta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            if (itemId && delta) {
                const prev = this.agentMessageBuffers.get(itemId) ?? '';
                this.agentMessageBuffers.set(itemId, prev + delta);
            }
            return events;
        }

        if (method === 'item/reasoning/textDelta') {
            const itemId = extractItemId(paramsRecord) ?? 'reasoning';
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            if (delta) {
                const prev = this.reasoningBuffers.get(itemId) ?? '';
                this.reasoningBuffers.set(itemId, prev + delta);
                events.push({ type: 'agent_reasoning_delta', delta });
            }
            return events;
        }

        if (method === 'item/reasoning/summaryPartAdded') {
            events.push({ type: 'agent_reasoning_section_break' });
            return events;
        }

        if (method === 'item/commandExecution/outputDelta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.output ?? paramsRecord.stdout);
            if (itemId && delta) {
                const prev = this.commandOutputBuffers.get(itemId) ?? '';
                this.commandOutputBuffers.set(itemId, prev + delta);
            }
            return events;
        }

        if (method === 'item/started' || method === 'item/completed') {
            const item = extractItem(paramsRecord);
            if (!item) return events;

            const itemType = normalizeItemType(item.type ?? item.itemType ?? item.kind);
            const itemId = extractItemId(paramsRecord) ?? asString(item.id ?? item.itemId ?? item.item_id);

            if (!itemType || !itemId) {
                return events;
            }

            if (itemType === 'agentmessage') {
                if (method === 'item/completed') {
                    const text = asString(item.text ?? item.message ?? item.content) ?? this.agentMessageBuffers.get(itemId);
                    if (text) {
                        events.push({ type: 'agent_message', message: text });
                    }
                    this.agentMessageBuffers.delete(itemId);
                }
                return events;
            }

            if (itemType === 'reasoning') {
                if (method === 'item/completed') {
                    const text = asString(item.text ?? item.message ?? item.content) ?? this.reasoningBuffers.get(itemId);
                    if (text) {
                        events.push({ type: 'agent_reasoning', text });
                    }
                    this.reasoningBuffers.delete(itemId);
                }
                return events;
            }

            if (itemType === 'commandexecution') {
                if (this.wrappedCommandIds.has(itemId)) {
                    return events;
                }

                if (method === 'item/started') {
                    const command = extractCommand(item.command ?? item.cmd ?? item.args);
                    const cwd = asString(item.cwd ?? item.workingDirectory ?? item.working_directory);
                    const autoApproved = asBoolean(item.autoApproved ?? item.auto_approved);
                    const meta: Record<string, unknown> = {};
                    if (command) meta.command = command;
                    if (cwd) meta.cwd = cwd;
                    if (autoApproved !== null) meta.auto_approved = autoApproved;
                    this.commandMeta.set(itemId, meta);

                    events.push({
                        type: 'exec_command_begin',
                        call_id: itemId,
                        ...meta
                    });
                }

                if (method === 'item/completed') {
                    const meta = this.commandMeta.get(itemId) ?? {};
                    const rawOutput = item.output ?? item.result ?? item.stdout;
                    const outputInfo = extractCommandOutput(rawOutput);
                    const output = outputInfo.output ?? this.commandOutputBuffers.get(itemId);
                    const stdout = asString(item.stdout) ?? outputInfo.stdout;
                    const stderr = asString(item.stderr) ?? outputInfo.stderr;
                    const error = asString(item.error);
                    const exitCode = asNumber(item.exitCode ?? item.exit_code ?? item.exitcode ?? outputInfo.outputRaw?.exitCode ?? outputInfo.outputRaw?.exit_code);
                    const status = asString(item.status);

                    events.push({
                        type: 'exec_command_end',
                        call_id: itemId,
                        ...meta,
                        ...(output ? { output } : {}),
                        ...(stdout ? { stdout } : {}),
                        ...(stderr ? { stderr } : {}),
                        ...(error ? { error } : {}),
                        ...(exitCode !== null ? { exit_code: exitCode } : {}),
                        ...(status ? { status } : {}),
                        ...(outputInfo.outputRaw ? { output_raw: outputInfo.outputRaw } : {})
                    });

                    this.commandMeta.delete(itemId);
                    this.commandOutputBuffers.delete(itemId);
                }

                return events;
            }

            if (itemType === 'filechange') {
                if (method === 'item/started') {
                    const changes = extractChanges(item.changes ?? item.change ?? item.diff);
                    const autoApproved = asBoolean(item.autoApproved ?? item.auto_approved);
                    const meta: Record<string, unknown> = {};
                    if (changes) meta.changes = changes;
                    if (autoApproved !== null) meta.auto_approved = autoApproved;
                    this.fileChangeMeta.set(itemId, meta);

                    events.push({
                        type: 'patch_apply_begin',
                        call_id: itemId,
                        ...meta
                    });
                }

                if (method === 'item/completed') {
                    const meta = this.fileChangeMeta.get(itemId) ?? {};
                    const stdout = asString(item.stdout ?? item.output);
                    const stderr = asString(item.stderr);
                    const success = asBoolean(item.success ?? item.ok ?? item.applied ?? item.status === 'completed');

                    events.push({
                        type: 'patch_apply_end',
                        call_id: itemId,
                        ...meta,
                        ...(stdout ? { stdout } : {}),
                        ...(stderr ? { stderr } : {}),
                        success: success ?? false
                    });

                    this.fileChangeMeta.delete(itemId);
                }

                return events;
            }
        }

        logger.debug('[AppServerEventConverter] Unhandled notification', { method, params });
        return events;
    }

    private handleCodexWrappedEvent(msgType: string, msg: Record<string, unknown>): ConvertedEvent[] {
        if (msgType === 'error') {
            const message = asString(msg.message);
            if (message) {
                return [{ type: 'codex_error', error: message }];
            }
            return [];
        }

        if (msgType === 'task_started') {
            const turnId = asString(msg.turn_id ?? msg.turnId);
            return [{ type: 'task_started', ...(turnId ? { turn_id: turnId } : {}) }];
        }

        if (msgType === 'task_complete') {
            const turnId = asString(msg.turn_id ?? msg.turnId);
            return [{ type: 'task_complete', ...(turnId ? { turn_id: turnId } : {}) }];
        }

        if (msgType === 'task_failed') {
            const error = asString(msg.error ?? msg.message);
            return [{ type: 'task_failed', ...(error ? { error } : {}) }];
        }

        if (msgType === 'turn_aborted') {
            const turnId = asString(msg.turn_id ?? msg.turnId);
            return [{ type: 'turn_aborted', ...(turnId ? { turn_id: turnId } : {}) }];
        }

        if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
            const callId = asString(msg.call_id ?? msg.callId ?? msg.id);
            if (!callId) return [];
            this.wrappedCommandIds.add(callId);
            const command = extractCommand(msg.command ?? msg.cmd ?? msg.args);
            const cwd = asString(msg.cwd ?? msg.workingDirectory ?? msg.working_directory);
            const autoApproved = asBoolean(msg.autoApproved ?? msg.auto_approved);
            const event: ConvertedEvent = {
                type: 'exec_command_begin',
                call_id: callId,
                ...(command ? { command } : {}),
                ...(cwd ? { cwd } : {})
            };
            if (autoApproved !== null) event.auto_approved = autoApproved;
            return [event];
        }

        if (msgType === 'exec_command_end') {
            const callId = asString(msg.call_id ?? msg.callId ?? msg.id);
            if (!callId) return [];
            this.wrappedCommandIds.add(callId);

            const command = extractCommand(msg.command ?? msg.cmd ?? msg.args);
            const cwd = asString(msg.cwd ?? msg.workingDirectory ?? msg.working_directory);
            const exitCode = asNumber(msg.exit_code ?? msg.exitCode ?? msg.exitcode);
            const status = asString(msg.status);
            const error = asString(msg.error ?? msg.err);
            const outputInfo = extractCommandOutput(msg.output ?? msg.result ?? msg.formatted_output ?? msg.aggregated_output ?? msg.stdout);
            const stdout = asString(msg.stdout) ?? outputInfo.stdout;
            const stderr = asString(msg.stderr) ?? outputInfo.stderr;

            return [{
                type: 'exec_command_end',
                call_id: callId,
                ...(command ? { command } : {}),
                ...(cwd ? { cwd } : {}),
                ...(outputInfo.output ? { output: outputInfo.output } : {}),
                ...(stdout ? { stdout } : {}),
                ...(stderr ? { stderr } : {}),
                ...(error ? { error } : {}),
                ...(exitCode !== null ? { exit_code: exitCode } : {}),
                ...(status ? { status } : {}),
                ...(outputInfo.outputRaw ? { output_raw: outputInfo.outputRaw } : {})
            }];
        }

        if (msgType === 'patch_apply_begin') {
            const callId = asString(msg.call_id ?? msg.callId ?? msg.id);
            if (!callId) return [];
            const changes = extractChanges(msg.changes ?? msg.change ?? msg.diff);
            const autoApproved = asBoolean(msg.autoApproved ?? msg.auto_approved);
            const event: ConvertedEvent = { type: 'patch_apply_begin', call_id: callId };
            if (changes) event.changes = changes;
            if (autoApproved !== null) event.auto_approved = autoApproved;
            return [event];
        }

        if (msgType === 'patch_apply_end') {
            const callId = asString(msg.call_id ?? msg.callId ?? msg.id);
            if (!callId) return [];
            const outputInfo = extractCommandOutput(msg.output ?? msg.result ?? msg.stdout);
            const stdout = asString(msg.stdout) ?? outputInfo.stdout;
            const stderr = asString(msg.stderr) ?? outputInfo.stderr;
            const success = asBoolean(msg.success ?? msg.ok ?? msg.applied ?? (asString(msg.status)?.toLowerCase() === 'completed'));
            return [{
                type: 'patch_apply_end',
                call_id: callId,
                ...(stdout ? { stdout } : {}),
                ...(stderr ? { stderr } : {}),
                success: success ?? false
            }];
        }

        return [];
    }

    reset(): void {
        this.agentMessageBuffers.clear();
        this.reasoningBuffers.clear();
        this.commandOutputBuffers.clear();
        this.commandMeta.clear();
        this.fileChangeMeta.clear();
        this.wrappedCommandIds.clear();
    }
}
