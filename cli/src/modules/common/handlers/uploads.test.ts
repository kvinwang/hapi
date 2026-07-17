import { dirname } from 'node:path'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { cleanupUploadDir, registerUploadHandlers } from './uploads'

const sessionIds = new Set<string>()

afterEach(async () => {
    await Promise.all([...sessionIds].map((sessionId) => cleanupUploadDir(sessionId)))
    sessionIds.clear()
})

async function upload(manager: RpcHandlerManager, sessionId: string, filename: string) {
    const raw = await manager.handleRequest({
        method: `${sessionId}:uploadFile`,
        params: JSON.stringify({
            sessionId,
            filename,
            content: Buffer.from('image bytes').toString('base64'),
            mimeType: 'image/png'
        })
    })
    return JSON.parse(raw) as { success: boolean; path?: string; error?: string }
}

describe('upload handlers', () => {
    it('recreates a cached upload directory removed by a tmp cleaner', async () => {
        const sessionId = `upload-test-${crypto.randomUUID()}`
        sessionIds.add(sessionId)
        const manager = new RpcHandlerManager({ scopePrefix: sessionId })
        registerUploadHandlers(manager)

        const first = await upload(manager, sessionId, 'first.png')
        expect(first.success).toBe(true)
        expect(first.path).toBeTruthy()

        await rm(dirname(first.path!), { recursive: true, force: true })

        const second = await upload(manager, sessionId, 'second.png')
        expect(second.success).toBe(true)
        expect(second.path).toBeTruthy()
        expect(dirname(second.path!)).not.toBe(dirname(first.path!))
    })
})
