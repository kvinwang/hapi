import { describe, expect, it } from 'vitest'
import { BaseLocalLauncher } from './BaseLocalLauncher'

class QueueStub {
    size(): number {
        return 0
    }

    reset(): void {}

    setOnMessage(_callback: ((...args: unknown[]) => void) | null): void {}
}

class RpcHandlerManagerStub {
    readonly handlers = new Map<string, () => Promise<void> | void>()

    registerHandler(method: string, handler: () => Promise<void> | void): void {
        this.handlers.set(method, handler)
    }
}

describe('BaseLocalLauncher', () => {
    it('runs cleanup callback before abort/switch flow', async () => {
        const queue = new QueueStub()
        const rpcHandlerManager = new RpcHandlerManagerStub()
        const calls: string[] = []

        const launcher = new BaseLocalLauncher({
            label: 'test-local',
            failureLabel: 'failed',
            queue,
            rpcHandlerManager,
            onBeforeAbortOrSwitch: () => {
                calls.push('before')
            },
            launch: async (abortSignal) => {
                await new Promise<void>((resolve) => {
                    abortSignal.addEventListener('abort', () => {
                        calls.push('aborted')
                        resolve()
                    }, { once: true })
                })
            },
            sendFailureMessage: () => {},
            recordLocalLaunchFailure: () => {}
        })

        const runPromise = launcher.run()
        const abortHandler = rpcHandlerManager.handlers.get('abort')
        expect(abortHandler).toBeTypeOf('function')

        await abortHandler?.()

        await expect(runPromise).resolves.toBe('switch')
        expect(calls).toEqual(['before', 'aborted'])
    })
})
