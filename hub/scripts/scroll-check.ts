/**
 * Measures whether loading older history disturbs the reading position.
 *
 * Seeds a tool-dense session, serves it from a real hub, drives headless Chrome
 * over the DevTools protocol, and reports two things per "load older" round:
 * how far a fixed anchor message drifts, and whether an expanded tool group
 * keeps its rows. Both must stay put — a group that gains or loses rows changes
 * height right above the reader even when the anchor maths is correct.
 *
 *   bun run scripts/scroll-check.ts
 *
 * Needs a Chrome binary; set CHROME_PATH if the Playwright cache is elsewhere.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const CHROME = process.env.CHROME_PATH
    ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome')
const TOKEN = 'scrollchecktoken'
const HUB_PORT = 3211
const CDP_PORT = 9333
const SESSION_ID = 'scroll-check-session'
const TURNS = 12
const TOOLS_PER_TURN = 14

function seed(dbPath: string): void {
    const db = new Database(dbPath)
    const now = Date.now()
    db.prepare(
        'INSERT OR IGNORE INTO sessions (id, tag, namespace, metadata, active, created_at, updated_at, active_at, seq) VALUES (?,?,?,?,?,?,?,?,0)'
    ).run(SESSION_ID, 'scroll-check', 'default', JSON.stringify({ path: '/tmp', host: 'local' }), 0, now, now, now)

    let seq = 0
    const insert = db.prepare(
        'INSERT INTO messages (id, session_id, content, created_at, seq, local_id, role) VALUES (?,?,?,?,?,NULL,?)'
    )
    const add = (content: unknown, role: string) => {
        seq += 1
        insert.run(`m-${seq}`, SESSION_ID, JSON.stringify(content), now - 1_000_000 + seq * 100, seq, role)
    }
    const assistant = (blocks: unknown[]) => ({
        role: 'agent',
        content: { type: 'output', data: { type: 'assistant', message: { id: `api-${seq}`, content: blocks } } }
    })

    for (let turn = 0; turn < TURNS; turn += 1) {
        add({ role: 'user', content: { type: 'text', text: `Turn ${turn}: please investigate the failure` } }, 'user')
        for (let tool = 0; tool < TOOLS_PER_TURN; tool += 1) {
            const id = `t${turn}-${tool}`
            add(assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/src/module${tool}.ts` } }]), 'assistant')
            add({
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'line\n'.repeat(400) }] }
                    }
                }
            }, 'assistant')
        }
        add(assistant([{ type: 'text', text: `Turn ${turn} answer.\n\n${'Detail sentence. '.repeat(30)}` }]), 'assistant')
    }
    db.close()
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            await fetch(url)
            return
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 200))
        }
    }
    throw new Error(`timed out waiting for ${url}`)
}

class Cdp {
    private socket!: WebSocket
    private nextId = 1
    private readonly pending = new Map<number, (value: unknown) => void>()

    async connect(wsUrl: string): Promise<void> {
        this.socket = new WebSocket(wsUrl)
        this.socket.addEventListener('message', (event) => {
            const parsed = JSON.parse(String(event.data)) as { id?: number; result?: unknown }
            if (typeof parsed.id === 'number') {
                this.pending.get(parsed.id)?.(parsed.result)
                this.pending.delete(parsed.id)
            }
        })
        await new Promise<void>((resolve, reject) => {
            this.socket.addEventListener('open', () => resolve())
            this.socket.addEventListener('error', () => reject(new Error('CDP connection failed')))
        })
    }

    send(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = this.nextId++
        return new Promise((resolve) => {
            this.pending.set(id, resolve as (value: unknown) => void)
            this.socket.send(JSON.stringify({ id, method, params }))
        })
    }

    async evaluate<T>(expression: string): Promise<T> {
        const response = await this.send('Runtime.evaluate', {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true
        })
        if (response?.exceptionDetails) {
            throw new Error(JSON.stringify(response.exceptionDetails.exception?.description ?? response.exceptionDetails))
        }
        return response?.result?.value as T
    }

    close(): void {
        this.socket.close()
    }
}

const home = mkdtempSync(join(tmpdir(), 'hapi-scroll-'))
const profile = mkdtempSync(join(tmpdir(), 'chrome-scroll-'))
const hub = spawn('bun', ['run', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
        ...process.env,
        HAPI_HOME: home,
        DB_PATH: join(home, 'hapi.db'),
        CLI_API_TOKEN: TOKEN,
        HAPI_LISTEN_PORT: String(HUB_PORT),
        TELEGRAM_NOTIFICATION: 'false'
    },
    stdio: 'ignore'
})

const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=900,800',
    'about:blank'
], { stdio: 'ignore' })

const cleanup = () => {
    hub.kill('SIGKILL')
    chrome.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
}
process.on('exit', cleanup)

if (!existsSync(CHROME)) {
    console.error(`No Chrome binary at ${CHROME}. Set CHROME_PATH to one.`)
    process.exit(1)
}

try {
    await waitForHttp(`http://127.0.0.1:${HUB_PORT}/api/health`, 30_000)
    seed(join(home, 'hapi.db'))
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30_000)

    const url = `http://127.0.0.1:${HUB_PORT}/sessions/${SESSION_ID}?token=${TOKEN}`
    const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string }

    const cdp = new Cdp()
    await cdp.connect(tab.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    const ready = await cdp.evaluate<boolean>(`
        const deadline = Date.now() + 30000
        while (Date.now() < deadline) {
            const viewport = document.querySelector('.chat-viewport')
            if (viewport && viewport.querySelectorAll('[data-happy-message-id]').length > 0) return true
            await new Promise((r) => setTimeout(r, 200))
        }
        return false
    `)
    if (!ready) throw new Error('chat never rendered')

    // Park the viewport near the top so the loader arms, note where the first
    // visible message sits, then let older history land and look again. Any
    // non-zero drift is the jump the user sees.
    const report = await cdp.evaluate<{ rounds: Array<{ drift: number; grew: number; anchor: string }> }>(`
        const viewport = document.querySelector('.chat-viewport')
        const firstVisible = () => {
            const top = viewport.getBoundingClientRect().top
            return [...viewport.querySelectorAll('[data-happy-message-id]')]
                .find((node) => node.getBoundingClientRect().bottom > top + 8) ?? null
        }
        const settle = async () => {
            let stable = 0
            let last = -1
            for (let frame = 0; frame < 240 && stable < 8; frame += 1) {
                await new Promise((r) => requestAnimationFrame(r))
                const height = viewport.scrollHeight
                stable = height === last ? stable + 1 : 0
                last = height
            }
        }

        viewport.scrollTop = viewport.scrollHeight
        await settle()

        const rounds = []
        for (let round = 0; round < 6; round += 1) {
            viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }))
            viewport.scrollTop = 120
            viewport.dispatchEvent(new Event('scroll', { bubbles: true }))

            const node = firstVisible()
            if (!node) break
            const anchor = node.dataset.happyMessageId
            const before = node.getBoundingClientRect().top
            const heightBefore = viewport.scrollHeight

            const deadline = Date.now() + 5000
            while (Date.now() < deadline && viewport.scrollHeight === heightBefore) {
                await new Promise((r) => setTimeout(r, 50))
            }
            await settle()

            const after = viewport.querySelector('[data-happy-message-id="' + anchor + '"]')
            const grew = viewport.scrollHeight - heightBefore
            if (!after) { rounds.push({ drift: NaN, grew, anchor }); break }
            rounds.push({ drift: Math.round(after.getBoundingClientRect().top - before), grew, anchor })
            if (grew === 0) break
        }
        return { rounds }
    `)

    for (const [index, round] of report.rounds.entries()) {
        console.log(`  round ${index + 1}: +${round.grew}px above, anchor "${round.anchor}" drifted ${round.drift}px`)
    }
    const drifts = report.rounds.map((round) => Math.abs(round.drift)).filter((value) => !Number.isNaN(value))
    console.log(`worst drift     : ${drifts.length ? Math.max(...drifts) : 'n/a'}px`)

    // The case that actually bites: the oldest tool group is expanded, so any
    // change to its membership changes its height right above the reader.
    const expanded = await cdp.evaluate<{ rows: [number, number]; drift: number } | null>(`
        const viewport = document.querySelector('.chat-viewport')
        const settle = async () => {
            let stable = 0, last = -1
            for (let frame = 0; frame < 240 && stable < 8; frame += 1) {
                await new Promise((r) => requestAnimationFrame(r))
                stable = viewport.scrollHeight === last ? stable + 1 : 0
                last = viewport.scrollHeight
            }
        }
        const oldestGroup = () => [...viewport.querySelectorAll('[data-happy-message-id^="tool:tool-group:"]')][0] ?? null
        const rowCount = (card) => card.querySelectorAll('[aria-expanded]').length === 0
            ? 0
            : card.querySelectorAll('button').length

        viewport.scrollTop = 0
        await settle()
        const card = oldestGroup()
        if (!card) return null

        const toggle = card.querySelector('[aria-expanded]')
        if (!toggle) return null
        toggle.click()
        await settle()

        const rowsBefore = rowCount(card)
        // Anchor on the first message below the expanded group.
        const nodes = [...viewport.querySelectorAll('[data-happy-message-id]')]
        const below = nodes[nodes.indexOf(card) + 1]
        if (!below) return null
        const anchorId = below.dataset.happyMessageId

        // Arm and position the viewport first, so the baseline is taken from
        // where the reader actually is when the load fires.
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }))
        viewport.scrollTop = 60
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }))
        const before = below.getBoundingClientRect().top
        const heightBefore = viewport.scrollHeight

        const deadline = Date.now() + 6000
        while (Date.now() < deadline && viewport.scrollHeight === heightBefore) {
            await new Promise((r) => setTimeout(r, 50))
        }
        await settle()

        const after = viewport.querySelector('[data-happy-message-id="' + anchorId + '"]')
        const stillThere = viewport.querySelector('[data-happy-message-id="' + card.dataset.happyMessageId + '"]')
        return {
            rows: [rowsBefore, stillThere ? rowCount(stillThere) : -1],
            drift: after ? Math.round(after.getBoundingClientRect().top - before) : NaN
        }
    `)

    console.log('--- oldest tool group expanded, then load older ---')
    if (expanded) {
        console.log(`  group rows      : ${expanded.rows[0]} -> ${expanded.rows[1]}`)
        console.log(`  anchor below it : drifted ${expanded.drift}px`)
    } else {
        console.log('  (no tool group at the top to expand)')
    }

    cdp.close()
} finally {
    cleanup()
}
