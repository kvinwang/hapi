/**
 * RPC request/response handler for browser control.
 * Pure logic — no terminal/shell concerns.
 */

export type Request = {
    method: string
    args?: Record<string, unknown>
}

export type Response = {
    code: number
    data?: unknown
    error?: string
}

let activeTabId: number | null = null

export async function handleRequest(req: Request): Promise<Response> {
    try {
        switch (req.method) {
            case 'tabs':        return await cmdTabs()
            case 'open':        return await cmdOpen(req.args)
            case 'close':       return await cmdClose(req.args)
            case 'goto':        return await cmdGoto(req.args)
            case 'tab':         return await cmdTab(req.args)
            case 'title':       return await cmdTitle()
            case 'url':         return await cmdUrl()
            case 'text':        return await cmdText()
            case 'html':        return await cmdHtml(req.args)
            case 'query':       return await cmdQuery(req.args)
            case 'click':       return await cmdClick(req.args)
            case 'type':        return await cmdType(req.args)
            case 'value':       return await cmdValue(req.args)
            case 'js':          return await cmdJs(req.args)
            case 'screenshot':  return await cmdScreenshot(req.args)
            case 'back':        return await cmdBack()
            case 'forward':     return await cmdForward()
            case 'reload':      return await cmdReload()
            case 'wait':        return await cmdWait(req.args)
            case 'cookies':     return await cmdCookies(req.args)
            case 'useragent':   return await cmdUserAgent()
            case 'help':        return cmdHelp()
            default:
                return { code: 1, error: `Unknown method: ${req.method}` }
        }
    } catch (err: any) {
        return { code: 1, error: err?.message ?? String(err) }
    }
}

// ── Helpers ────────────────────────────────────────────────────

function ok(data?: unknown): Response {
    return { code: 0, data }
}

function err(message: string): Response {
    return { code: 1, error: message }
}

async function ensureActiveTab(): Promise<number | null> {
    if (activeTabId != null) {
        try {
            await chrome.tabs.get(activeTabId)
            return activeTabId
        } catch {
            activeTabId = null
        }
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tabs.length > 0 && tabs[0].id != null) {
        activeTabId = tabs[0].id
        return activeTabId
    }
    return null
}

function requireTab(): Promise<number> {
    return ensureActiveTab().then(id => {
        if (id == null) throw new Error('No active tab. Use "open <url>" or "tab <id>" first.')
        return id
    })
}

function waitForTabLoad(tabId: number): Promise<void> {
    return new Promise((resolve) => {
        const timeout = setTimeout(resolve, 10000)
        const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
            if (id === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener)
                clearTimeout(timeout)
                resolve()
            }
        }
        chrome.tabs.onUpdated.addListener(listener)
    })
}

// ── Commands ───────────────────────────────────────────────────

async function cmdTabs(): Promise<Response> {
    const tabs = await chrome.tabs.query({})
    return ok(tabs.map(t => ({
        id: t.id,
        title: t.title ?? '',
        url: t.url ?? '',
        active: t.id === activeTabId,
    })))
}

async function cmdOpen(args?: Record<string, unknown>): Promise<Response> {
    let url = String(args?.url ?? '')
    if (!url) return err('Missing arg: url')
    if (!url.match(/^https?:\/\//)) url = 'https://' + url
    const tab = await chrome.tabs.create({ url, active: true })
    activeTabId = tab.id ?? null
    return ok({ id: tab.id, url })
}

async function cmdClose(args?: Record<string, unknown>): Promise<Response> {
    const tabId = args?.id != null ? Number(args.id) : activeTabId
    if (tabId == null || isNaN(tabId)) return err('No tab to close')
    await chrome.tabs.remove(tabId)
    if (tabId === activeTabId) activeTabId = null
    return ok({ id: tabId })
}

async function cmdGoto(args?: Record<string, unknown>): Promise<Response> {
    const tabId = await requireTab()
    let url = String(args?.url ?? '')
    if (!url) return err('Missing arg: url')
    if (!url.match(/^https?:\/\//)) url = 'https://' + url
    await chrome.tabs.update(tabId, { url })
    await waitForTabLoad(tabId)
    return ok({ url })
}

async function cmdTab(args?: Record<string, unknown>): Promise<Response> {
    const tabId = Number(args?.id)
    if (isNaN(tabId)) return err('Missing arg: id')
    try {
        await chrome.tabs.update(tabId, { active: true })
        activeTabId = tabId
        const tab = await chrome.tabs.get(tabId)
        return ok({ id: tabId, title: tab.title, url: tab.url })
    } catch {
        return err(`Tab ${tabId} not found`)
    }
}

async function cmdTitle(): Promise<Response> {
    const tabId = await requireTab()
    const tab = await chrome.tabs.get(tabId)
    return ok(tab.title ?? '')
}

async function cmdUrl(): Promise<Response> {
    const tabId = await requireTab()
    const tab = await chrome.tabs.get(tabId)
    return ok(tab.url ?? '')
}

async function cmdText(): Promise<Response> {
    const tabId = await requireTab()
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.body.innerText,
    })
    return ok(results[0]?.result ?? '')
}

async function cmdHtml(args?: Record<string, unknown>): Promise<Response> {
    const tabId = await requireTab()
    const selector = String(args?.selector ?? 'body')
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (s: string) => {
            const el = document.querySelector(s)
            return el ? el.outerHTML : null
        },
        args: [selector],
    })
    const html = results[0]?.result
    if (html == null) return err(`No element matches: ${selector}`)
    return ok(html)
}

async function cmdQuery(args?: Record<string, unknown>): Promise<Response> {
    const tabId = await requireTab()
    const selector = String(args?.selector ?? '')
    if (!selector) return err('Missing arg: selector')
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (s: string) => {
            const els = document.querySelectorAll(s)
            return Array.from(els).slice(0, 50).map((el) => {
                const tag = el.tagName.toLowerCase()
                const id = el.id ? `#${el.id}` : ''
                const cls = el.className && typeof el.className === 'string'
                    ? '.' + el.className.trim().split(/\s+/).join('.')
                    : ''
                const text = (el.textContent ?? '').trim().slice(0, 80)
                return { tag, id, cls, text }
            })
        },
        args: [selector],
    })
    return ok(results[0]?.result ?? [])
}

async function cmdClick(args?: Record<string, unknown>): Promise<Response> {
    const tabId = await requireTab()
    const selector = String(args?.selector ?? '')
    if (!selector) return err('Missing arg: selector')
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (s: string) => {
            const el = document.querySelector(s) as HTMLElement | null
            if (!el) return false
            el.click()
            return true
        },
        args: [selector],
    })
    return results[0]?.result ? ok() : err(`No element matches: ${selector}`)
}

async function cmdType(args?: Record<string, unknown>): Promise<Response> {
    const tabId = await requireTab()
    const selector = String(args?.selector ?? '')
    const text = String(args?.text ?? '')
    if (!selector || !text) return err('Missing args: selector, text')
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (s: string, t: string) => {
            const el = document.querySelector(s) as HTMLInputElement | null
            if (!el) return false
            el.focus()
            el.value = t
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
        },
        args: [selector, text],
    })
    return results[0]?.result ? ok() : err(`No element matches: ${selector}`)
}

async function cmdValue(args?: Record<string, unknown>): Promise<Response> {
    const tabId = await requireTab()
    const selector = String(args?.selector ?? '')
    if (!selector) return err('Missing arg: selector')

    if (args?.value !== undefined) {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (s: string, v: string) => {
                const el = document.querySelector(s) as HTMLInputElement | null
                if (el) {
                    el.value = v
                    el.dispatchEvent(new Event('input', { bubbles: true }))
                }
            },
            args: [selector, String(args.value)],
        })
        return ok()
    }

    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (s: string) => {
            const el = document.querySelector(s) as HTMLInputElement | null
            return el?.value ?? null
        },
        args: [selector],
    })
    return ok(results[0]?.result)
}

async function cmdJs(args?: Record<string, unknown>): Promise<Response> {
    const code = String(args?.code ?? '')
    if (!code) return err('Missing arg: code')
    const tabId = await requireTab()
    // Use MAIN world to avoid extension CSP blocking eval
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (c: string) => {
            try {
                const result = eval(c)
                if (result === undefined) return { v: 'undefined' }
                if (result === null) return { v: 'null' }
                if (typeof result === 'object') {
                    try { return { v: JSON.stringify(result, null, 2) } } catch { return { v: String(result) } }
                }
                return { v: String(result) }
            } catch (e: any) {
                return { e: e.message }
            }
        },
        args: [code],
    })
    const r = results[0]?.result as { v?: string; e?: string } | undefined
    if (r?.e) return err(r.e)
    return ok(r?.v ?? 'undefined')
}

async function cmdScreenshot(args?: Record<string, unknown>): Promise<Response> {
    const tabId = await requireTab()
    const tab = await chrome.tabs.get(tabId)
    const selector = args?.selector ? String(args.selector) : undefined

    if (!selector) {
        // Full visible tab screenshot
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
        return ok(dataUrl.replace(/^data:image\/png;base64,/, ''))
    }

    // Element screenshot: scroll into view, get rect, capture, crop
    const rectResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: (s: string) => {
            const el = document.querySelector(s)
            if (!el) return null
            el.scrollIntoView({ block: 'center', inline: 'center' })
            const r = el.getBoundingClientRect()
            return {
                x: Math.round(r.x * devicePixelRatio),
                y: Math.round(r.y * devicePixelRatio),
                w: Math.round(r.width * devicePixelRatio),
                h: Math.round(r.height * devicePixelRatio),
            }
        },
        args: [selector],
    })

    const rect = rectResults[0]?.result as { x: number; y: number; w: number; h: number } | null
    if (!rect) return err(`No element matches: ${selector}`)
    if (rect.w === 0 || rect.h === 0) return err('Element has zero size')

    // Small delay for scroll to settle
    await new Promise(r => setTimeout(r, 150))

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })

    // Crop using OffscreenCanvas
    const resp = await fetch(dataUrl)
    const blob = await resp.blob()
    const bitmap = await createImageBitmap(blob, rect.x, rect.y, rect.w, rect.h)
    const canvas = new OffscreenCanvas(rect.w, rect.h)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const croppedBlob = await canvas.convertToBlob({ type: 'image/png' })
    const buf = await croppedBlob.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let b64 = ''
    for (let i = 0; i < bytes.length; i++) {
        b64 += String.fromCharCode(bytes[i])
    }
    return ok(btoa(b64))
}

async function cmdBack(): Promise<Response> {
    const tabId = await requireTab()
    await chrome.scripting.executeScript({ target: { tabId }, func: () => history.back() })
    return ok()
}

async function cmdForward(): Promise<Response> {
    const tabId = await requireTab()
    await chrome.scripting.executeScript({ target: { tabId }, func: () => history.forward() })
    return ok()
}

async function cmdReload(): Promise<Response> {
    const tabId = await requireTab()
    await chrome.tabs.reload(tabId)
    await waitForTabLoad(tabId)
    return ok()
}

async function cmdWait(args?: Record<string, unknown>): Promise<Response> {
    const ms = Number(args?.ms ?? 0)
    if (ms <= 0) return err('Missing arg: ms')
    await new Promise(resolve => setTimeout(resolve, Math.min(ms, 30000)))
    return ok()
}

async function cmdCookies(args?: Record<string, unknown>): Promise<Response> {
    const url = args?.url ? String(args.url) : undefined
    const cookies = url
        ? await chrome.cookies.getAll({ url })
        : await chrome.cookies.getAll({})
    return ok(cookies.slice(0, 100).map(c => ({
        domain: c.domain,
        name: c.name,
        value: c.value,
    })))
}

async function cmdUserAgent(): Promise<Response> {
    const tabId = await requireTab()
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => navigator.userAgent,
    })
    return ok(results[0]?.result ?? '')
}

function cmdHelp(): Response {
    return ok({
        methods: {
            tabs: {},
            open: { args: { url: 'string' } },
            close: { args: { id: 'number?' } },
            goto: { args: { url: 'string' } },
            tab: { args: { id: 'number' } },
            title: {},
            url: {},
            text: {},
            html: { args: { selector: 'string?' } },
            query: { args: { selector: 'string' } },
            click: { args: { selector: 'string' } },
            type: { args: { selector: 'string', text: 'string' } },
            value: { args: { selector: 'string', value: 'string?' } },
            js: { args: { code: 'string' } },
            screenshot: {},
            back: {},
            forward: {},
            reload: {},
            wait: { args: { ms: 'number' } },
            cookies: { args: { url: 'string?' } },
            useragent: {},
        }
    })
}
