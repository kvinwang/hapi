import { describe, expect, it } from 'vitest';
import { AppServerEventConverter } from './appServerEventConverter';

describe('AppServerEventConverter', () => {
    it('maps thread/started', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/started', { thread: { id: 'thread-1' } });

        expect(events).toEqual([{ type: 'thread_started', thread_id: 'thread-1' }]);
    });

    it('maps thread/resumed', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/resumed', { thread: { id: 'thread-2' } });

        expect(events).toEqual([{ type: 'thread_started', thread_id: 'thread-2' }]);
    });

    it('maps turn/started and completed statuses', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('turn/started', { turn: { id: 'turn-1' } });
        expect(started).toEqual([{ type: 'task_started', turn_id: 'turn-1' }]);

        const completed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Completed' });
        expect(completed).toEqual([{ type: 'task_complete', turn_id: 'turn-1' }]);

        const interrupted = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Interrupted' });
        expect(interrupted).toEqual([{ type: 'turn_aborted', turn_id: 'turn-1' }]);

        const failed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Failed', message: 'boom' });
        expect(failed).toEqual([{ type: 'task_failed', turn_id: 'turn-1', error: 'boom' }]);
    });

    it('accumulates agent message deltas', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hello' });
        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: ' world' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'msg-1', type: 'agentMessage' }
        });

        expect(completed).toEqual([{ type: 'agent_message', message: 'Hello world' }]);
    });

    it('maps command execution items and output deltas', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: { id: 'cmd-1', type: 'commandExecution', command: 'ls' }
        });
        expect(started).toEqual([{
            type: 'exec_command_begin',
            call_id: 'cmd-1',
            command: 'ls'
        }]);

        converter.handleNotification('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'ok' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'cmd-1', type: 'commandExecution', exitCode: 0 }
        });

        expect(completed).toEqual([{
            type: 'exec_command_end',
            call_id: 'cmd-1',
            command: 'ls',
            output: 'ok',
            exit_code: 0
        }]);
    });

    it('maps reasoning deltas', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('item/reasoning/textDelta', { itemId: 'r1', delta: 'step' });
        expect(events).toEqual([{ type: 'agent_reasoning_delta', delta: 'step' }]);
    });

    it('maps diff updates', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('turn/diff/updated', { diff: 'diff --git a b' });
        expect(events).toEqual([{ type: 'turn_diff', unified_diff: 'diff --git a b' }]);
    });

    it('maps codex/event/error to codex_error', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/error', {
            id: 'turn-1',
            msg: {
                type: 'error',
                message: 'Your access token could not be refreshed',
                codex_error_info: 'unauthorized'
            },
            conversationId: 'conv-1'
        });

        expect(events).toEqual([{ type: 'codex_error', error: 'Your access token could not be refreshed' }]);
    });

    it('maps codex/event/task_started', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/task_started', {
            id: 'turn-1',
            msg: { type: 'task_started', turn_id: 'turn-1' },
            conversationId: 'conv-1'
        });

        expect(events).toEqual([{ type: 'task_started', turn_id: 'turn-1' }]);
    });

    it('maps codex/event/task_complete', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/task_complete', {
            id: 'turn-1',
            msg: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: null },
            conversationId: 'conv-1'
        });

        expect(events).toEqual([{ type: 'task_complete', turn_id: 'turn-1' }]);
    });

    it('maps codex/event/task_failed', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/task_failed', {
            id: 'turn-1',
            msg: { type: 'task_failed', error: 'something broke' },
            conversationId: 'conv-1'
        });

        expect(events).toEqual([{ type: 'task_failed', error: 'something broke' }]);
    });

    it('ignores unknown codex/event/ types', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/mcp_startup_update', {
            msg: { type: 'mcp_startup_update', server: 'hapi' }
        });

        expect(events).toEqual([]);
    });
});
