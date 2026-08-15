/**
 * Server-side HTML renderer for the low-power ("lite") UI.
 *
 * Design constraints, all driven by the target device (an iPad stuck on iPadOS 17,
 * A9X/A10-class SoC, LCD panel):
 *
 * - **Zero CSS animations and transitions.** The full SPA keeps `animate-spin` /
 *   `animate-pulse` running for the entire duration of an agent turn; on a weak GPU
 *   that alone keeps the compositor awake for minutes at a time.
 * - **No compositing triggers.** No `backdrop-blur`, `box-shadow`, `filter`, transforms
 *   or `position: sticky` — the SPA puts a blur layer above a scrolling list, which
 *   forces a backdrop re-sample every scroll frame.
 * - **No nested scroll container.** The document itself scrolls, so there is no
 *   scroll-anchoring machinery (the SPA runs a ResizeObserver + a subtree
 *   MutationObserver + a self-rescheduling rAF chain, and every streamed token
 *   triggers a synchronous reflow through it).
 * - **No client-side syntax highlighting or math.** Code is plain `<pre>`.
 * - **No web fonts.** System font stack only.
 *
 * `content-visibility: auto` would be the natural way to skip off-screen work, but it
 * only shipped in Safari 18 — hence the message cap plus explicit pagination instead.
 */

import type { Session } from '@hapi/protocol/types'
import {
    buildRenderedMessages,
    buildToolResultMap,
    escapeHtml,
    toolResultText,
    type ProjectableMessage,
    type RenderedMessage,
    type RenderedToolResult
} from '../routes/sharePage'
import { safeStringify } from '@hapi/protocol'
import { renderMarkdown, renderPlainText } from './markdown'

/** Longest tool input/result we inline before truncating. Keeps the DOM small. */
const MAX_PRE_LENGTH = 4000

export const LITE_BASE = '/lite'

/* ------------------------------------------------------------------ styles */

/**
 * Deliberately small. Served inline so a page is a single request with no
 * render-blocking stylesheet fetch.
 */
const STYLES = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1c1c1e;--dim:#6b6b70;--line:#dcdcd8;--card:#fff;--accent:#1c4fd8;--warn:#8a5a00;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e2e2e6;--dim:#9a9aa2;--line:#33333a;--card:#1e1e23;--accent:#7aa2f7;--warn:#d9a441;--err:#f2857d}}
*,*::before,*::after{animation:none!important;transition:none!important;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,sans-serif;padding:0 12px 24px;max-width:820px;margin:0 auto}
a{color:var(--accent)}
hr{border:0;border-top:1px solid var(--line);margin:0}
header{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);margin-bottom:10px}
header h1{font-size:17px;margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{display:inline-block;padding:7px 12px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);font-size:15px;text-decoration:none;cursor:pointer;font-family:inherit}
.btn-danger{color:var(--err)}
.dim{color:var(--dim);font-size:13px}
.row{display:block;padding:11px 2px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--fg)}
.row .t{font-size:16px}
.row .s{color:var(--dim);font-size:13px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}
.dot-on{background:#2e9e4f}.dot-off{background:#9a9aa2}.dot-req{background:#d9a441}
.msg{padding:10px 0;border-bottom:1px solid var(--line)}
.msg .who{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);margin-bottom:4px}
.msg.user .who{color:var(--accent)}
.text{white-space:pre-wrap;overflow-wrap:break-word}
.md{overflow-wrap:break-word}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p{margin:.5em 0}
.md h3,.md h4,.md h5,.md h6{margin:.8em 0 .35em;font-size:1em;font-weight:650}
.md ul,.md ol{margin:.5em 0;padding-left:1.4em}
.md li{margin:.2em 0}
.md li.task{list-style:none;margin-left:-1.2em}
.md code{background:var(--card);border:1px solid var(--line);border-radius:3px;padding:.05em .3em;font:.88em/1.4 ui-monospace,Menlo,monospace}
.md pre{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:8px;overflow-x:auto;white-space:pre;font:13px/1.45 ui-monospace,Menlo,monospace;margin:.5em 0;max-height:340px}
.md blockquote{margin:.5em 0;padding-left:.75em;border-left:3px solid var(--line);color:var(--dim)}
.md hr{margin:.8em 0}
.md table{border-collapse:collapse;margin:.5em 0;display:block;overflow-x:auto;font-size:14px}
.md th,.md td{border:1px solid var(--line);padding:.3em .5em;text-align:left}
.md th{background:var(--card);font-weight:650}
pre{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:8px;overflow-x:auto;font:13px/1.45 ui-monospace,Menlo,monospace;margin:4px 0 0;max-height:340px}
pre.err{border-color:var(--err)}
details{margin:6px 0}
summary{color:var(--dim);font-size:14px;cursor:pointer}
.tool{border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0;background:var(--card)}
.tool h3{font-size:14px;margin:0;font-weight:600}
.lbl{font-size:12px;color:var(--dim);margin-top:6px}
.req{border:1px solid var(--warn);border-radius:6px;padding:10px;margin:10px 0;background:var(--card)}
.req h3{margin:0 0 6px;font-size:15px}
.req .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
form.composer{display:flex;gap:8px;align-items:flex-end;padding-top:12px}
textarea{flex:1;font:16px/1.4 inherit;font-family:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);resize:vertical;min-height:44px}
.note{color:var(--dim);font-size:13px;padding:8px 0}
.err-box{border:1px solid var(--err);color:var(--err);border-radius:6px;padding:8px;margin:8px 0}
`

/* ------------------------------------------------------------------ layout */

export function layout(opts: { title: string; body: string; script?: string }): string {
    return `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(opts.title)}</title>
<style>${STYLES}</style>
</head><body>
${opts.body}
${opts.script ? `<script>${opts.script}</script>` : ''}
</body></html>`
}

/* ------------------------------------------------------------------- utils */

/** Relative time, rendered once on the server — a live-updating clock would need a timer. */
export function relTime(ms: number, now: number): string {
    const d = Math.max(0, now - ms)
    const s = Math.floor(d / 1000)
    if (s < 60) return '刚刚'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m} 分钟前`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h} 小时前`
    const day = Math.floor(h / 24)
    if (day < 30) return `${day} 天前`
    return new Date(ms).toISOString().slice(0, 10)
}

function truncate(text: string): string {
    if (text.length <= MAX_PRE_LENGTH) return text
    return `${text.slice(0, MAX_PRE_LENGTH)}\n… (已截断 ${text.length - MAX_PRE_LENGTH} 字符)`
}

function pre(text: string, isError = false): string {
    return `<pre${isError ? ' class="err"' : ''}>${escapeHtml(truncate(text))}</pre>`
}

/**
 * Session title for the lite UI.
 *
 * Mirrors the share page's precedence (name → summary → path basename) but keeps its
 * own fallback: `metadata` is nullable in practice — the cache nulls it whenever the
 * stored blob fails `MetadataSchema` (which requires `host`) — and the share page's
 * "Shared Session" wording makes no sense here.
 */
export function sessionTitle(session: Session): string {
    const meta = (session.metadata ?? null) as Record<string, unknown> | null
    if (meta) {
        if (typeof meta.name === 'string' && meta.name) return meta.name
        const summary = meta.summary as Record<string, unknown> | undefined
        if (summary && typeof summary.text === 'string' && summary.text) return summary.text
        if (typeof meta.path === 'string' && meta.path) {
            const parts = meta.path.split('/').filter(Boolean)
            if (parts.length > 0) return parts[parts.length - 1]
        }
    }
    return `会话 ${session.id.slice(0, 8)}`
}

export function pendingRequestCount(session: Session): number {
    const requests = session.agentState?.requests
    return requests ? Object.keys(requests).length : 0
}

function sessionSubtitle(session: Session): string {
    const meta = (session.metadata ?? null) as Record<string, unknown> | null
    const bits: string[] = []
    if (meta && typeof meta.path === 'string' && meta.path) bits.push(meta.path)
    if (meta && typeof meta.flavor === 'string' && meta.flavor) bits.push(meta.flavor)
    return bits.join(' · ')
}

/* --------------------------------------------------------------- list page */

export function renderSessionListPage(sessions: Session[], now: number): string {
    const rows = sessions.map((s) => {
        const title = sessionTitle(s)
        const pending = pendingRequestCount(s)
        const dot = pending > 0 ? 'dot-req' : s.active ? 'dot-on' : 'dot-off'
        const state = pending > 0
            ? `${pending} 待批准`
            : s.thinking ? '运行中' : s.active ? '空闲' : '已断开'
        const sub = [sessionSubtitle(s), state, relTime(s.updatedAt, now)].filter(Boolean).join(' · ')
        return `<a class="row" href="${LITE_BASE}/s/${encodeURIComponent(s.id)}">
<div class="t"><span class="dot ${dot}"></span>${escapeHtml(title)}</div>
<div class="s">${escapeHtml(sub)}</div></a>`
    }).join('\n')

    const body = `<header><h1>HAPI 省电版</h1>
<a class="btn" href="${LITE_BASE}">刷新</a></header>
${rows || '<p class="note">没有会话。</p>'}
<p class="note">共 ${sessions.length} 个会话 · 更新于 ${escapeHtml(new Date(now).toTimeString().slice(0, 5))}</p>
<p class="note"><a href="/">切换回完整版</a></p>`

    return layout({ title: 'HAPI 省电版', body })
}

/* ------------------------------------------------------------ message HTML */

function renderBlocks(m: RenderedMessage): string {
    const out: string[] = []
    for (const b of m.blocks) {
        if (b.type === 'text') {
            // Agent output is markdown; user messages are whatever was typed, and
            // rendering those as markdown would mangle them. Same split as the SPA.
            out.push(m.role === 'user' ? renderPlainText(b.text) : renderMarkdown(b.text))
        } else if (b.type === 'reasoning') {
            // <details> is native collapse — no JS, no measured height, no animation.
            out.push(`<details><summary>思考过程</summary>${renderMarkdown(b.text)}</details>`)
        } else if (b.type === 'tool_use') {
            const head = b.description
                ? `${escapeHtml(b.name)} — ${escapeHtml(b.description)}`
                : escapeHtml(b.name)
            const parts = [`<div class="tool"><h3>${head}</h3>`]
            parts.push(`<details><summary>输入</summary>${pre(safeStringify(b.input ?? {}))}</details>`)
            if (b.result) {
                const text = toolResultText(b.result.content)
                parts.push(`<details><summary>${b.result.is_error ? '结果(错误)' : '结果'}</summary>${pre(text, b.result.is_error)}</details>`)
            }
            parts.push('</div>')
            out.push(parts.join(''))
        } else if (b.type === 'summary') {
            out.push(`<div class="text"><strong>摘要:</strong> ${escapeHtml(b.summary)}</div>`)
        } else if (b.type === 'event') {
            out.push(`<div class="dim">事件: ${escapeHtml(b.event)}</div>`)
        }
    }
    return out.join('\n')
}

const ROLE_LABEL: Record<RenderedMessage['role'], string> = {
    user: '你',
    assistant: '助手',
    event: '事件'
}

function renderMessage(m: RenderedMessage): string {
    const label = m.model ? `${ROLE_LABEL[m.role]} · ${escapeHtml(m.model)}` : ROLE_LABEL[m.role]
    return `<div class="msg ${m.role}" data-seq="${m.seq}">
<div class="who">${label}</div>
${renderBlocks(m)}
</div>`
}

export function renderMessages(messages: ProjectableMessage[]): string {
    return buildRenderedMessages(messages).map(renderMessage).join('\n')
}

function renderOrphanResult(result: RenderedToolResult): string {
    const label = result.is_error ? '工具结果(错误)' : '工具结果'
    return `<div class="msg assistant">
<div class="who">${label}</div>
<div class="tool">${pre(toolResultText(result.content), result.is_error)}</div>
</div>`
}

/**
 * Render an incremental batch for the live tail.
 *
 * The projection folds a `tool_result` into the `tool_use` card it belongs to and drops
 * it as a standalone message. That is right for a whole conversation, but a tail batch
 * is a window: when the call was rendered in an earlier batch, its result lands in a
 * later one with nothing to fold into, and would vanish. Since the client only ever
 * appends, such results are emitted as their own card instead.
 */
export function renderTail(messages: ProjectableMessage[]): string {
    const rendered = buildRenderedMessages(messages)
    const byId = new Map(rendered.map((m) => [m.id, m]))

    const foldedHere = new Set<string>()
    for (const m of rendered) {
        for (const b of m.blocks) {
            if (b.type === 'tool_use') foldedHere.add(b.id)
        }
    }

    const out: string[] = []
    for (const raw of messages) {
        const message = byId.get(raw.id)
        if (message) {
            out.push(renderMessage(message))
            continue
        }
        for (const [toolUseId, result] of buildToolResultMap([raw])) {
            if (foldedHere.has(toolUseId)) continue
            out.push(renderOrphanResult(result))
        }
    }
    return out.join('\n')
}

/* -------------------------------------------------------- permission cards */

/**
 * Rendered into its own container so the client can swap it wholesale on update —
 * permission requests live in `agentState`, not in the message stream, so they do
 * not arrive through the message tail.
 */
export function renderRequests(session: Session): string {
    const requests = session.agentState?.requests
    if (!requests) return ''
    const sid = encodeURIComponent(session.id)
    return Object.entries(requests).map(([id, req]) => {
        const args = safeStringify(req.arguments ?? {})
        const rid = encodeURIComponent(id)
        return `<div class="req"><h3>需要批准: ${escapeHtml(req.tool)}</h3>
<details><summary>参数</summary>${pre(args)}</details>
<div class="acts">
<form method="post" action="${LITE_BASE}/s/${sid}/permission/${rid}"><input type="hidden" name="decision" value="approved"><button class="btn" type="submit">批准</button></form>
<form method="post" action="${LITE_BASE}/s/${sid}/permission/${rid}"><input type="hidden" name="decision" value="approved_for_session"><button class="btn" type="submit">本会话都批准</button></form>
<form method="post" action="${LITE_BASE}/s/${sid}/permission/${rid}"><input type="hidden" name="decision" value="denied"><button class="btn btn-danger" type="submit">拒绝</button></form>
</div></div>`
    }).join('\n')
}

export function renderStatus(session: Session): string {
    const pending = pendingRequestCount(session)
    if (pending > 0) return `<span class="dot dot-req"></span>等待批准 (${pending})`
    if (session.thinking) return '<span class="dot dot-on"></span>运行中'
    if (session.active) return '<span class="dot dot-on"></span>空闲'
    return '<span class="dot dot-off"></span>已断开'
}

/* ------------------------------------------------------------ session page */

export function renderSessionPage(opts: {
    session: Session
    messages: ProjectableMessage[]
    lastSeq: number
    hasMore: boolean
    oldestSeq: number | null
    live: boolean
    /** Reading an older window, so live updates are off and the tail is not the page end. */
    historical?: boolean
    error?: string
    script: string
}): string {
    const { session, messages, lastSeq, hasMore, oldestSeq, live } = opts
    const title = sessionTitle(session)
    const sid = encodeURIComponent(session.id)

    const older = hasMore && oldestSeq !== null
        ? `<p class="note"><a href="${LITE_BASE}/s/${sid}?before=${oldestSeq}">载入更早的消息</a></p>`
        : ''

    const body = `<header>
<a class="btn" href="${LITE_BASE}">←</a>
<h1>${escapeHtml(title)}</h1>
<form method="post" action="${LITE_BASE}/s/${sid}/abort"><button class="btn btn-danger" type="submit">停止</button></form>
</header>
${opts.error ? `<div class="err-box">${escapeHtml(opts.error)}</div>` : ''}
<div class="dim" id="status">${renderStatus(session)}</div>
<div id="requests">${renderRequests(session)}</div>
${older}
<div id="msgs" data-session="${escapeHtml(session.id)}" data-last-seq="${lastSeq}" data-live="${live ? '1' : '0'}">
${renderMessages(messages)}
</div>
<form class="composer" method="post" action="${LITE_BASE}/s/${sid}/send">
<textarea name="text" rows="2" placeholder="发送消息…" autocapitalize="sentences"></textarea>
<button class="btn" type="submit">发送</button>
</form>
${opts.historical
        ? `<p class="note">正在查看历史消息(实时更新已暂停) · <a href="${LITE_BASE}/s/${sid}">回到最新</a></p>`
        : `<p class="note">${live ? '实时更新已开启 · ' : ''}<a href="${LITE_BASE}/s/${sid}?live=${live ? '0' : '1'}">${live ? '关闭实时更新(更省电)' : '开启实时更新'}</a></p>`}`

    return layout({ title, body, script: opts.script })
}

export function renderLoginPage(error?: string): string {
    const body = `<header><h1>HAPI 省电版</h1></header>
${error ? `<div class="err-box">${escapeHtml(error)}</div>` : ''}
<p class="note">粘贴访问令牌以登录。令牌会保存在本机 cookie 中。</p>
<form method="post" action="${LITE_BASE}/login">
<textarea name="token" rows="3" placeholder="访问令牌"></textarea>
<p><button class="btn" type="submit">登录</button></p>
</form>`
    return layout({ title: 'HAPI 省电版 · 登录', body })
}
