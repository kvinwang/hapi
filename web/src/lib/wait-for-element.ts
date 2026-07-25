export function waitForElementById(id: string, timeoutMs = 1_000): Promise<HTMLElement | null> {
    const existing = document.getElementById(id)
    if (existing) return Promise.resolve(existing)

    return new Promise((resolve) => {
        const finish = (element: HTMLElement | null) => {
            observer.disconnect()
            clearTimeout(timeout)
            resolve(element)
        }
        const observer = new MutationObserver(() => {
            const element = document.getElementById(id)
            if (element) finish(element)
        })
        const timeout = setTimeout(() => finish(null), timeoutMs)
        observer.observe(document.body, { childList: true, subtree: true })
    })
}

export function nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}
