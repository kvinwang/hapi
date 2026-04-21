import axios, { isAxiosError } from 'axios'
import type { AgentState, CreateMachineResponse, CreateSessionResponse, GetSessionResponse, ListMachinesResponse, RunnerState, Machine, MachineMetadata, Metadata, Session, SessionHistoryResponse, SessionHistoryRole } from '@/api/types'
import { AgentStateSchema, CreateMachineResponseSchema, CreateSessionResponseSchema, GetSessionResponseSchema, ListMachinesResponseSchema, RunnerStateSchema, MachineMetadataSchema, MetadataSchema, SessionHistoryResponseSchema } from '@/api/types'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { apiValidationError } from '@/utils/errorUtils'
import { ApiMachineClient } from './apiMachine'
import { ApiSessionClient } from './apiSession'

export class ApiClient {
    static async create(): Promise<ApiClient> {
        return new ApiClient(getAuthToken())
    }

    private constructor(private readonly token: string) { }

    async getOrCreateSession(opts: {
        tag: string
        metadata: Metadata
        state: AgentState | null
        parentSessionId?: string | null
    }): Promise<Session> {
        const response = await axios.post<CreateSessionResponse>(
            `${configuration.apiUrl}/cli/sessions`,
            {
                tag: opts.tag,
                metadata: opts.metadata,
                agentState: opts.state,
                parentSessionId: opts.parentSessionId ?? null
            },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60_000
            }
        )

        const parsed = CreateSessionResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw apiValidationError('Invalid /cli/sessions response', response)
        }

        const raw = parsed.data.session

        const metadata = (() => {
            if (raw.metadata == null) return null
            const parsedMetadata = MetadataSchema.safeParse(raw.metadata)
            return parsedMetadata.success ? parsedMetadata.data : null
        })()

        const agentState = (() => {
            if (raw.agentState == null) return null
            const parsedAgentState = AgentStateSchema.safeParse(raw.agentState)
            return parsedAgentState.success ? parsedAgentState.data : null
        })()

        return {
            id: raw.id,
            parentSessionId: raw.parentSessionId ?? null,
            namespace: raw.namespace,
            seq: raw.seq,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            active: raw.active,
            activeAt: raw.activeAt,
            metadata,
            metadataVersion: raw.metadataVersion,
            agentState,
            agentStateVersion: raw.agentStateVersion,
            thinking: raw.thinking,
            thinkingAt: raw.thinkingAt,
            todos: raw.todos,
            permissionMode: raw.permissionMode,
            modelMode: raw.modelMode
        }
    }

    async getSession(sessionId: string): Promise<Session> {
        const response = await axios.get<GetSessionResponse>(
            `${configuration.apiUrl}/cli/sessions/${encodeURIComponent(sessionId)}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`
                },
                timeout: 30_000
            }
        )

        const parsed = GetSessionResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw apiValidationError('Invalid /cli/sessions/:id response', response)
        }

        const raw = parsed.data.session
        const metadata = (() => {
            if (raw.metadata == null) return null
            const parsedMetadata = MetadataSchema.safeParse(raw.metadata)
            return parsedMetadata.success ? parsedMetadata.data : null
        })()
        const agentState = (() => {
            if (raw.agentState == null) return null
            const parsedAgentState = AgentStateSchema.safeParse(raw.agentState)
            return parsedAgentState.success ? parsedAgentState.data : null
        })()

        return {
            id: raw.id,
            parentSessionId: raw.parentSessionId ?? null,
            namespace: raw.namespace,
            seq: raw.seq,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            active: raw.active,
            activeAt: raw.activeAt,
            metadata,
            metadataVersion: raw.metadataVersion,
            agentState,
            agentStateVersion: raw.agentStateVersion,
            thinking: raw.thinking,
            thinkingAt: raw.thinkingAt,
            todos: raw.todos,
            permissionMode: raw.permissionMode,
            modelMode: raw.modelMode
        }
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await axios.patch(
            `${configuration.apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
            { name },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30_000
            }
        )
    }

    async uploadHostedFile(opts: {
        sessionId: string
        filename: string
        content: string
        mimeType?: string
    }): Promise<{ id: string; url: string }> {
        const response = await axios.post<{ id: string; url: string }>(
            `${configuration.apiUrl}/cli/files`,
            {
                sessionId: opts.sessionId,
                filename: opts.filename,
                content: opts.content,
                mimeType: opts.mimeType ?? 'application/octet-stream'
            },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60_000
            }
        )

        const data = response.data
        if (!data || typeof data.id !== 'string' || typeof data.url !== 'string') {
            throw new Error('Invalid /cli/files response')
        }

        return data
    }

    async listMachines(): Promise<Machine[]> {
        const response = await axios.get<ListMachinesResponse>(
            `${configuration.apiUrl}/cli/machines`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`
                },
                timeout: 30_000
            }
        )

        const parsed = ListMachinesResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw apiValidationError('Invalid /cli/machines response', response)
        }

        return parsed.data.machines.map(raw => {
            const metadata = (() => {
                if (raw.metadata == null) return null
                const parsedMetadata = MachineMetadataSchema.safeParse(raw.metadata)
                return parsedMetadata.success ? parsedMetadata.data : null
            })()

            const runnerState = (() => {
                if (raw.runnerState == null) return null
                const parsedRunnerState = RunnerStateSchema.safeParse(raw.runnerState)
                return parsedRunnerState.success ? parsedRunnerState.data : null
            })()

            return {
                id: raw.id,
                seq: raw.seq,
                createdAt: raw.createdAt,
                updatedAt: raw.updatedAt,
                active: raw.active,
                activeAt: raw.activeAt,
                metadata,
                metadataVersion: raw.metadataVersion,
                runnerState,
                runnerStateVersion: raw.runnerStateVersion,
                notes: raw.notes ?? null
            }
        })
    }

    async updateMachineNotes(machineId: string, notes: string | null): Promise<void> {
        await axios.patch(
            `${configuration.apiUrl}/cli/machines/${encodeURIComponent(machineId)}/notes`,
            { notes },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30_000
            }
        )
    }

    async deleteMachine(machineId: string): Promise<void> {
        await axios.delete(
            `${configuration.apiUrl}/api/machines/${encodeURIComponent(machineId)}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`
                },
                timeout: 30_000
            }
        )
    }

    async createInvite(): Promise<{ token: string; expiresAt: number; command: string }> {
        const response = await axios.post<{ ok: boolean; token: string; expiresAt: number; command: string }>(
            `${configuration.apiUrl}/api/invites`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${this.token}`
                },
                timeout: 30_000
            }
        )
        return response.data
    }

    async getOrCreateMachine(opts: {
        machineId: string
        metadata: MachineMetadata
        runnerState?: RunnerState
    }): Promise<Machine> {
        let response
        try {
            response = await axios.post<CreateMachineResponse>(
                `${configuration.apiUrl}/cli/machines`,
                {
                    id: opts.machineId,
                    metadata: opts.metadata,
                    runnerState: opts.runnerState ?? null
                },
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60_000
                }
            )
        } catch (err) {
            if (isAxiosError(err) && err.response?.data?.error) {
                throw new Error(`Machine registration failed (${err.response.status}): ${err.response.data.error}`)
            }
            throw err
        }

        const parsed = CreateMachineResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw apiValidationError('Invalid /cli/machines response', response)
        }

        const raw = parsed.data.machine

        const metadata = (() => {
            if (raw.metadata == null) return null
            const parsedMetadata = MachineMetadataSchema.safeParse(raw.metadata)
            return parsedMetadata.success ? parsedMetadata.data : null
        })()

        const runnerState = (() => {
            if (raw.runnerState == null) return null
            const parsedRunnerState = RunnerStateSchema.safeParse(raw.runnerState)
            return parsedRunnerState.success ? parsedRunnerState.data : null
        })()

        return {
            id: raw.id,
            seq: raw.seq,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            active: raw.active,
            activeAt: raw.activeAt,
            metadata,
            metadataVersion: raw.metadataVersion,
            runnerState,
            runnerStateVersion: raw.runnerStateVersion,
            notes: raw.notes ?? null
        }
    }

    async getSessionHistory(
        sessionId: string,
        options: {
            tail?: number
            search?: string
            role?: SessionHistoryRole
            afterSeq?: number
            beforeSeq?: number
            limit?: number
            snippet?: boolean
        }
    ): Promise<SessionHistoryResponse> {
        const response = await axios.get<SessionHistoryResponse>(
            `${configuration.apiUrl}/cli/sessions/${encodeURIComponent(sessionId)}/history`,
            {
                params: {
                    tail: options.tail,
                    search: options.search,
                    role: options.role,
                    afterSeq: options.afterSeq,
                    beforeSeq: options.beforeSeq,
                    limit: options.limit,
                    snippet: options.snippet ? 'true' : undefined
                },
                headers: {
                    Authorization: `Bearer ${this.token}`
                },
                timeout: 30_000
            }
        )

        const parsed = SessionHistoryResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw apiValidationError('Invalid /cli/sessions/:id/history response', response)
        }

        return parsed.data
    }

    async importSshKey(machineId: string, publicKey: string): Promise<{ success: boolean; added?: boolean; message?: string; error?: string }> {
        const response = await axios.post(
            `${configuration.apiUrl}/cli/machines/${encodeURIComponent(machineId)}/import-ssh-key`,
            { publicKey },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30_000
            }
        )
        return response.data
    }

    async sendMessageToSession(sessionId: string, text: string, wait?: boolean): Promise<{ seq: number; reply?: string }> {
        const response = await axios.post<{ ok: boolean; seq: number; reply?: string }>(
            `${configuration.apiUrl}/cli/sessions/${encodeURIComponent(sessionId)}/send`,
            { text, wait },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: wait ? 10 * 60 * 1000 : 30_000
            }
        )
        return { seq: response.data.seq, reply: response.data.reply }
    }

    sessionSyncClient(session: Session): ApiSessionClient {
        return new ApiSessionClient(this.token, session)
    }

    machineSyncClient(machine: Machine): ApiMachineClient {
        return new ApiMachineClient(this.token, machine)
    }
}
