import { describe, expect, it } from 'bun:test'
import type { Session } from '@hapi/protocol/types'
import type { ProjectableMessage } from '../routes/sharePage'
import {
    layout,
    pendingRequestCount,
    relTime,
    renderMessages,
    renderTail,
    renderRequests,
    renderSessionListPage,
    renderSessionPage,
    renderStatus
} from './render'
import { LITE_CLIENT_JS } from './client'

/**
 * The lite UI exists to not burn battery on an old tablet, so the guarantees worth
 * pinning are the ones that would silently regress: no animation, no compositing
 * triggers, no client-side highlighting, and correct escaping (everything here is
 * string-concatenated HTML, so escaping is load-bearing, not cosmetic).
 */

function session(overrides: Partial<Session> = {}): Session {
    return {
        id: 'sess-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        active: true,
        activeAt: 1_700_000_000_000,
        metadata: { path: '/repo/demo', flavor: 'claude' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        ...overrides
    } as Session
}

function userMessage(id: string, seq: number, text: string): ProjectableMessage {
    return {
        id,
        seq,
        createdAt: 1_700_000_000_000,
        content: { role: 'user', content: { type: 'text', text } }
    }
}

function assistantMessage(id: string, seq: number, text: string): ProjectableMessage {
    return {
        id,
        seq,
        createdAt: 1_700_000_000_000,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { model: 'claude-test', content: [{ type: 'text', text }] } }
            }
        }
    }
}

describe('lite rendering', () => {
    it('escapes user-supplied text so a message cannot inject markup', () => {
        const html = renderMessages([userMessage('m1', 1, '<img src=x onerror="alert(1)">')])
        expect(html).not.toContain('<img')
        expect(html).toContain('&lt;img')
        expect(html).toContain('onerror=&quot;')
    })

    it('escapes the session title in the list and in the page header', () => {
        const evil = session({ metadata: { name: '</h1><script>alert(1)</script>' } as Session['metadata'] })
        const list = renderSessionListPage([evil], Date.now())
        const page = renderSessionPage({
            session: evil,
            messages: [],
            lastSeq: 0,
            hasMore: false,
            oldestSeq: null,
            live: true,
            script: ''
        })
        for (const html of [list, page]) {
            expect(html).not.toContain('<script>alert(1)</script>')
            expect(html).toContain('&lt;script&gt;')
        }
    })

    it('renders assistant text with its model label', () => {
        const html = renderMessages([assistantMessage('m2', 2, 'hello there')])
        expect(html).toContain('hello there')
        expect(html).toContain('claude-test')
        expect(html).toContain('data-seq="2"')
    })

    it('tolerates a null seq from a live engine message', () => {
        const html = renderMessages([{ ...userMessage('m3', 0, 'hi'), seq: null }])
        expect(html).toContain('data-seq="0"')
    })

    it('ships no animation, transition, blur, shadow or sticky positioning', () => {
        const html = renderSessionPage({
            session: session({ thinking: true }),
            messages: [assistantMessage('m1', 1, 'working')],
            lastSeq: 1,
            hasMore: true,
            oldestSeq: 1,
            live: true,
            script: LITE_CLIENT_JS
        })
        // The blanket reset is what neutralises anything added later by accident.
        expect(html).toContain('animation:none!important')
        expect(html).toContain('transition:none!important')
        expect(html).not.toContain('@keyframes')
        expect(html).not.toContain('backdrop-filter')
        expect(html).not.toContain('box-shadow')
        expect(html).not.toContain('position:sticky')
        expect(html).not.toContain('position:fixed')
    })

    it('loads no external subresource — one request, no web font, no stylesheet', () => {
        const html = renderSessionPage({
            session: session(),
            messages: [],
            lastSeq: 0,
            hasMore: false,
            oldestSeq: null,
            live: true,
            script: LITE_CLIENT_JS
        })
        expect(html).not.toContain('<link')
        expect(html).not.toContain('src="http')
        expect(html).not.toContain('@font-face')
        expect(html).not.toContain('<script src')
    })

    it('keeps the inline client script small', () => {
        // A budget, not a golden value: the point of this UI is that JS stays tiny.
        expect(LITE_CLIENT_JS.length).toBeLessThan(5000)
    })

    it('offers a live-update toggle so the page can be made fully static', () => {
        const live = renderSessionPage({
            session: session(), messages: [], lastSeq: 0, hasMore: false, oldestSeq: null, live: true, script: ''
        })
        expect(live).toContain('live=0')
        expect(live).toContain('data-live="1"')

        const off = renderSessionPage({
            session: session(), messages: [], lastSeq: 0, hasMore: false, oldestSeq: null, live: false, script: ''
        })
        expect(off).toContain('live=1')
        expect(off).toContain('data-live="0"')
    })

    it('paginates instead of rendering the whole history', () => {
        const html = renderSessionPage({
            session: session(), messages: [], lastSeq: 0, hasMore: true, oldestSeq: 41, live: true, script: ''
        })
        expect(html).toContain('before=41')
    })

    it('pauses live updates on a historical page so the tail cannot splice newer messages in', () => {
        const html = renderSessionPage({
            session: session(),
            messages: [],
            lastSeq: 20,
            hasMore: true,
            oldestSeq: 10,
            live: false,
            historical: true,
            script: ''
        })
        expect(html).toContain('data-live="0"')
        expect(html).toContain('回到最新')
        // The live toggle must not be offered here — turning it on would corrupt the view.
        expect(html).not.toContain('live=1')
    })

    it('omits the older-messages link when the history is exhausted', () => {
        const html = renderSessionPage({
            session: session(), messages: [], lastSeq: 0, hasMore: false, oldestSeq: 41, live: true, script: ''
        })
        expect(html).not.toContain('before=41')
    })
})

describe('lite tool grouping', () => {
    function toolMessage(seq: number, name: string): ProjectableMessage {
        return {
            id: `m${seq}`,
            seq,
            createdAt: 1_700_000_000_000,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: { content: [{ type: 'tool_use', id: `t${seq}`, name, input: {} }] }
                    }
                }
            }
        }
    }

    it('collapses a long run of tool-only messages into one block', () => {
        const html = renderMessages([
            toolMessage(1, 'Bash'), toolMessage(2, 'Read'), toolMessage(3, 'Edit'), toolMessage(4, 'Bash')
        ])
        expect(html).toContain('<details class="toolgroup">')
        expect(html).toContain('4 个工具调用')
        // Names are deduplicated for the summary.
        expect(html).toContain('Bash、Read、Edit')
        expect(html.match(/class="toolgroup"/g)?.length).toBe(1)
    })

    it('leaves a short run inline rather than hiding two calls behind a click', () => {
        const html = renderMessages([toolMessage(1, 'Bash'), toolMessage(2, 'Read')])
        expect(html).not.toContain('toolgroup')
        expect(html).toContain('Bash')
        expect(html).toContain('Read')
    })

    it('never groups a message that also carries prose', () => {
        // The text is the story; burying it under a disclosure defeats the point.
        const withText: ProjectableMessage = {
            id: 'mx',
            seq: 9,
            createdAt: 1_700_000_000_000,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            content: [
                                { type: 'text', text: 'Now I will look' },
                                { type: 'tool_use', id: 'tx', name: 'Bash', input: {} }
                            ]
                        }
                    }
                }
            }
        }
        const html = renderMessages([toolMessage(1, 'Bash'), toolMessage(2, 'Read'), withText, toolMessage(4, 'Edit')])
        expect(html).toContain('Now I will look')
        // The run of two before it is below the threshold, so nothing groups at all.
        expect(html).not.toContain('toolgroup')
    })

    it('breaks a run where prose interrupts it', () => {
        const html = renderMessages([
            toolMessage(1, 'Bash'), toolMessage(2, 'Read'), toolMessage(3, 'Edit'),
            assistantMessage('mid', 4, 'halfway'),
            toolMessage(5, 'Bash'), toolMessage(6, 'Read'), toolMessage(7, 'Edit')
        ])
        expect(html.match(/class="toolgroup"/g)?.length).toBe(2)
        expect(html).toContain('halfway')
    })
})

describe('lite touch layout', () => {
    const page = (overrides: Partial<Parameters<typeof renderSessionPage>[0]> = {}) => renderSessionPage({
        session: session(), messages: [], lastSeq: 0, hasMore: false, oldestSeq: null, live: true, script: '',
        ...overrides
    })

    it('puts every session control below the transcript, not in the header', () => {
        const html = page()
        const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'))
        expect(header).not.toContain('abort')
        expect(header).not.toContain('<form')

        // Approvals, stop and the composer all sit after the message list.
        const msgsAt = html.indexOf('id="msgs"')
        expect(html.indexOf('id="requests"')).toBeGreaterThan(msgsAt)
        expect(html.indexOf('class="bottombar"')).toBeGreaterThan(msgsAt)
        expect(html.indexOf('class="composer"')).toBeGreaterThan(msgsAt)
        expect(html).toContain('action="/lite/s/sess-1/abort"')
    })

    it('shows status top and bottom so both are updatable', () => {
        expect(page().match(/data-status/g)?.length).toBe(2)
    })

    it('asks the client to open a live session at the newest message', () => {
        expect(page()).toContain('data-scroll="bottom"')
    })

    it('does not jump to the bottom of a historical page', () => {
        expect(page({ live: false, historical: true })).not.toContain('data-scroll')
    })

    it('keeps the composer at 16px so iOS does not zoom on focus', () => {
        // Below 16px Safari zooms the viewport on focus and will not zoom back out.
        const html = page()
        expect(html).toContain('font-size:16px')
        // The `font` shorthand cannot take `inherit`; using it drops the whole rule.
        expect(html).not.toMatch(/textarea\{[^}]*font:\s*16px[^}]*inherit/)
    })

    it('tints user messages so they are findable while scrolling', () => {
        const html = renderSessionPage({
            session: session(),
            messages: [userMessage('u1', 1, 'hello')],
            lastSeq: 1, hasMore: false, oldestSeq: 1, live: true, script: ''
        })
        expect(html).toContain('class="msg user"')
        expect(html).toContain('--user-bg')
        expect(html).toContain('.msg.user{background:var(--user-bg)')
    })
})

describe('lite incremental tail', () => {
    function toolUseMessage(id: string, seq: number, toolUseId: string): ProjectableMessage {
        return {
            id,
            seq,
            createdAt: 1_700_000_000_000,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }] }
                    }
                }
            }
        }
    }

    function toolResultMessage(id: string, seq: number, toolUseId: string, text: string): ProjectableMessage {
        return {
            id,
            seq,
            createdAt: 1_700_000_000_000,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }
                    }
                }
            }
        }
    }

    it('folds a result into its call when both land in the same batch', () => {
        const html = renderTail([
            toolUseMessage('m1', 1, 'tool-1'),
            toolResultMessage('m2', 2, 'tool-1', 'RESULT-TEXT')
        ])
        expect(html).toContain('Bash')
        expect(html).toContain('RESULT-TEXT')
        // Folded into the call's card, not repeated as a standalone one.
        expect(html).not.toContain('工具结果')
    })

    it('still shows a result whose call was rendered in an earlier batch', () => {
        // The regression: the projection drops standalone tool_result messages, so an
        // append-only tail would lose the output of every tool that spans two batches.
        const html = renderTail([toolResultMessage('m2', 2, 'tool-1', 'LATE-RESULT')])
        expect(html).toContain('LATE-RESULT')
        expect(html).toContain('工具结果')
    })

    it('marks a late-arriving error result as an error', () => {
        const html = renderTail([{
            id: 'm3',
            seq: 3,
            createdAt: 1_700_000_000_000,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-9', content: 'BOOM', is_error: true }] }
                    }
                }
            }
        }])
        expect(html).toContain('BOOM')
        expect(html).toContain('工具结果(错误)')
        expect(html).toContain('class="err"')
    })

    it('renders ordinary messages exactly as the full page does', () => {
        const messages = [userMessage('m1', 1, 'hi'), assistantMessage('m2', 2, 'hello')]
        expect(renderTail(messages)).toBe(renderMessages(messages))
    })

    it('escapes late-arriving tool output', () => {
        const html = renderTail([toolResultMessage('m2', 2, 't', '<script>alert(1)</script>')])
        expect(html).not.toContain('<script>alert(1)</script>')
        expect(html).toContain('&lt;script&gt;')
    })
})

describe('lite permission requests', () => {
    const withRequest = session({
        agentState: { requests: { 'req-1': { tool: 'Bash', arguments: { command: 'rm -rf /' } } } }
    })

    it('renders an approve/deny form per pending request', () => {
        const html = renderRequests(withRequest)
        expect(html).toContain('Bash')
        expect(html).toContain('rm -rf /')
        expect(html).toContain('value="approved"')
        expect(html).toContain('value="approved_for_session"')
        expect(html).toContain('value="denied"')
        expect(html).toContain('/lite/s/sess-1/permission/req-1')
    })

    it('works without JavaScript — every action is a real form post', () => {
        const html = renderSessionPage({
            session: withRequest, messages: [], lastSeq: 0, hasMore: false, oldestSeq: null, live: true, script: ''
        })
        expect(html).toContain('method="post"')
        expect(html).toContain('action="/lite/s/sess-1/send"')
        expect(html).toContain('action="/lite/s/sess-1/abort"')
        expect(html).not.toContain('onclick=')
    })

    it('counts pending requests', () => {
        expect(pendingRequestCount(withRequest)).toBe(1)
        expect(pendingRequestCount(session())).toBe(0)
    })

    it('surfaces a pending request ahead of thinking state', () => {
        expect(renderStatus(withRequest)).toContain('等待批准')
        expect(renderStatus(session({ thinking: true }))).toContain('运行中')
        expect(renderStatus(session())).toContain('空闲')
        expect(renderStatus(session({ active: false }))).toContain('已断开')
    })
})

describe('lite session list', () => {
    it('links each session and shows its pending count', () => {
        const html = renderSessionListPage([
            session({ id: 'a', agentState: { requests: { r: { tool: 'Edit', arguments: {} } } } }),
            session({ id: 'b', active: false })
        ], 1_700_000_060_000)
        expect(html).toContain('href="/lite/s/a"')
        expect(html).toContain('href="/lite/s/b"')
        expect(html).toContain('1 待批准')
        expect(html).toContain('已断开')
    })

    it('renders an empty state rather than a blank page', () => {
        expect(renderSessionListPage([], Date.now())).toContain('没有会话')
    })

    it('offers a way back to the full UI', () => {
        const html = renderSessionListPage([], Date.now())
        expect(html).toContain('href="/"')
        expect(html).toContain('切换回完整版')
    })
})

describe('relTime', () => {
    const now = 1_700_000_000_000

    it('formats coarse buckets and never renders a live-updating clock', () => {
        expect(relTime(now, now)).toBe('刚刚')
        expect(relTime(now - 90_000, now)).toBe('1 分钟前')
        expect(relTime(now - 3 * 3600_000, now)).toBe('3 小时前')
        expect(relTime(now - 2 * 86_400_000, now)).toBe('2 天前')
        expect(relTime(now - 400 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('clamps future timestamps instead of showing negative durations', () => {
        expect(relTime(now + 60_000, now)).toBe('刚刚')
    })
})

describe('layout', () => {
    it('sets a viewport so the tablet does not render at desktop width', () => {
        const html = layout({ title: 't', body: '' })
        expect(html).toContain('width=device-width')
    })

    it('omits the script tag entirely when there is no script', () => {
        expect(layout({ title: 't', body: '' })).not.toContain('<script>')
    })
})

describe('lite client script contract', () => {
    /**
     * The inline script has no DOM to test against here, so these pin the invariants the
     * server side depends on. The serializer one is not hypothetical: without the
     * checked filter every radio group submits its *last* option, so the agent acts on
     * an answer the user never gave — and nothing else in the stack can detect that.
     */

    it('skips unchecked radios and checkboxes when serialising a form', () => {
        expect(LITE_CLIENT_JS).toContain("el.type==='radio'||el.type==='checkbox'")
        expect(LITE_CLIENT_JS).toContain('!el.checked')
    })

    it('submits repeated field names rather than collapsing a multi-select', () => {
        // The server parses with { all: true }; an object keyed by name would defeat it.
        expect(LITE_CLIENT_JS).toContain('data.push([el.name,el.value])')
    })

    it('swaps the request block on the pending-set key, not on markup equality', () => {
        expect(LITE_CLIENT_JS).toContain('data-key')
        expect(LITE_CLIENT_JS).toContain('d.requestsKey')
    })

    it('bounds the appended DOM', () => {
        expect(LITE_CLIENT_JS).toContain('MAX_NODES')
        expect(LITE_CLIENT_JS).toContain('removeChild(root.firstElementChild)')
    })

    it('tails after an action on any end-of-conversation page, including live=0', () => {
        expect(LITE_CLIENT_JS).toContain('if(atEnd)setTimeout(refresh,250)')
    })

    it('still ships without its comments', () => {
        expect(LITE_CLIENT_JS).not.toContain('//')
        expect(LITE_CLIENT_JS.length).toBeLessThan(5000)
    })
})
