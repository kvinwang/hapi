export function isCurrentPagePrecached(worker: ServiceWorker, assetUrls: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        const channel = new MessageChannel()
        const finish = (matches: boolean) => {
            clearTimeout(timeout)
            channel.port1.close()
            channel.port2.close()
            resolve(matches)
        }
        const timeout = setTimeout(() => finish(false), 1500)
        channel.port1.onmessage = (event: MessageEvent<unknown>) => finish(event.data === true)
        try {
            worker.postMessage({ type: 'CHECK_PAGE_ASSETS', assetUrls }, [channel.port2])
        } catch {
            finish(false)
        }
    })
}
