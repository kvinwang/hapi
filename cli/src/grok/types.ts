import type { GrokPermissionMode } from '@hapi/protocol/types';

export type PermissionMode = GrokPermissionMode;

export interface GrokMode {
    permissionMode: PermissionMode;
    model?: string;
    /** Grok ACP session/set_mode effort id: low|medium|high */
    effort?: 'low' | 'medium' | 'high';
}

export const GROK_MODEL_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'grok-4.5', label: 'Grok 4.5' },
    { value: 'grok-composer-2.5-fast', label: 'Composer 2.5 Fast' }
] as const;
