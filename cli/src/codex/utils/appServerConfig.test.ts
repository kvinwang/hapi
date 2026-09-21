import { describe, expect, it } from 'vitest';
import { buildThreadStartParams, buildTurnStartParams } from './appServerConfig';
import { codexSystemPrompt } from './systemPrompt';

describe('appServerConfig', () => {
    const mcpServers = { hapi: { command: 'node', args: ['mcp'] } };

    it('overlays the complete profile while retaining HAPI RPC tools and explicit model selection', () => {
        const providerConfig = {
            model: 'profile-default', model_provider: 'custom',
            model_providers: { custom: { name: 'Custom', base_url: 'https://provider.invalid/v1' } },
            features: { example: true },
            mcp_servers: { extra: { command: 'example' } }
        };
        const params = buildThreadStartParams({ mode: { permissionMode: 'default', model: 'explicit-model' }, mcpServers, providerConfig });
        expect(params.model).toBe('explicit-model');
        expect(params.config).toMatchObject(providerConfig);
        expect(params.config?.['mcp_servers.hapi']).toEqual(mcpServers.hapi);
        expect(params.config?.developer_instructions).toBe(codexSystemPrompt);
        expect(buildThreadStartParams({ mode: { permissionMode: 'default' }, mcpServers }).config?.model_provider).toBeUndefined();
    });

    it('applies CLI overrides when permission mode is default', () => {
        const params = buildThreadStartParams({
            mode: { permissionMode: 'default' },
            mcpServers,
            cliOverrides: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
        });

        expect(params.sandbox).toBe('danger-full-access');
        expect(params.approvalPolicy).toBe('never');
        expect(params.baseInstructions).toBe(codexSystemPrompt);
        expect(params.developerInstructions).toBe(codexSystemPrompt);
        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp']
            },
            developer_instructions: codexSystemPrompt
        });
    });

    it('uses on-request approvals for default Codex threads', () => {
        const params = buildThreadStartParams({
            mode: { permissionMode: 'default' },
            mcpServers
        });

        expect(params.sandbox).toBe('workspace-write');
        expect(params.approvalPolicy).toBe('on-request');
    });

    it('ignores CLI overrides when permission mode is not default', () => {
        const params = buildThreadStartParams({
            mode: { permissionMode: 'yolo' },
            mcpServers,
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(params.sandbox).toBe('danger-full-access');
        expect(params.approvalPolicy).toBe('never');
    });

    it('keeps on-failure approvals for safe-yolo threads', () => {
        const params = buildThreadStartParams({
            mode: { permissionMode: 'safe-yolo' },
            mcpServers
        });

        expect(params.sandbox).toBe('workspace-write');
        expect(params.approvalPolicy).toBe('on-failure');
    });

    it('uses full prompt instructions without extra concatenation', () => {
        const params = buildThreadStartParams({
            mode: { permissionMode: 'default' },
            mcpServers,
            instructions: 'Only respond in Chinese.'
        });

        expect(params.baseInstructions).toBe('Only respond in Chinese.');
        expect(params.developerInstructions).toBe('Only respond in Chinese.');
        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp']
            },
            developer_instructions: 'Only respond in Chinese.'
        });
    });

    it('builds turn params with mode defaults', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'read-only', model: 'o3' }
        });

        expect(params.threadId).toBe('thread-1');
        expect(params.input).toEqual([{ type: 'text', text: 'hello' }]);
        expect(params.approvalPolicy).toBe('never');
        expect(params.sandboxPolicy).toEqual({ type: 'readOnly' });
        expect(params.model).toBe('o3');
    });

    it('puts collaboration mode in turn params with model settings', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'default', model: 'o3', collaborationMode: 'plan' }
        });

        expect(params.collaborationMode).toEqual({ mode: 'plan', settings: { model: 'o3' } });
        expect(params.model).toBeUndefined();
    });

    it('applies CLI overrides for turns when permission mode is default', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'default' },
            cliOverrides: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
        });

        expect(params.approvalPolicy).toBe('never');
        expect(params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    });

    it('ignores CLI overrides for turns when permission mode is not default', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'safe-yolo' },
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(params.approvalPolicy).toBe('on-failure');
        expect(params.sandboxPolicy).toEqual({ type: 'workspaceWrite' });
    });

    it('prefers turn overrides', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'default' },
            overrides: { approvalPolicy: 'on-request', model: 'gpt-5' }
        });

        expect(params.approvalPolicy).toBe('on-request');
        expect(params.model).toBe('gpt-5');
    });
});
