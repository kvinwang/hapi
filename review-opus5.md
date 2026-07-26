# Session Chat Page — Performance & UX Review

**Scope:** `web/src/components/SessionChat.tsx`, `web/src/components/AssistantChat/*`, `web/src/lib/message-window-store.ts`, `web/src/chat/*`, `web/src/lib/assistant-runtime.ts`, `web/src/hooks/useSSE.ts`, `web/src/components/ToolCard/*`, `web/src/lib/shiki.ts`, plus the `hub/` message API and SSE delivery path.

**Method:** static reading of the full render/data pipeline. Analysis only — no code was modified. No profiling was run; cost estimates are derived from code shape and the window bounds declared in `message-window-store.ts`.

**Focus:** behaviour under long conversations and long runs of consecutive tool calls.

---

## 1. Executive summary

The session page is built on a **full-recompute, full-rebuild** architecture. Every notification from the message-window store re-normalizes, re-reduces, re-reconciles, re-groups and re-converts the *entire* visible window — up to `VISIBLE_WINDOW_SIZE = 400` messages normally, and up to `PREPEND_HARD_MAX = 2400` while browsing history (`web/src/lib/message-window-store.ts:23`, `:306`).

React rendering is throttled to ~6.7 Hz (`NOTIFY_THROTTLE_MS = 150`, `message-window-store.ts:60`). **The JavaScript work is not throttled at all** — it runs once per inbound SSE frame.

Three independent cost multipliers stack on top of each other:

| Chain | Trigger frequency | Cost per occurrence |
|---|---|---|
| `mergeMessages` full re-sort | once per SSE frame (up to 3× per frame when scrolled up) | O(n log n) + ~6 full-array allocations |
| `reduceChatBlocks` full recompute | every store notify | ~10 full passes + a new object per block |
| Every message component re-renders | every store notify | no virtualization; 9–11 store subscriptions per message |

The dominant single cost is an **O(N²)** selector in `AssistantMessage.tsx` (§3.1). The dominant *structural* problem for tool-heavy sessions is that tool groups are rebuilt from scratch every tick and are never memoized (§3.2, §3.3).

There is also one genuine correctness bug (Rules of Hooks, §5.1) and one data-loss path (reconnect backfill, §5.2).

---

## 2. Data flow

```
SSE frame
  → ingestIncomingMessages            (message-window-store.ts:762)
  → mergeMessages                     (lib/messages.ts:35)          [full sort]
  → buildState                        (message-window-store.ts:229) [deriveSeqBounds: full scan]
  → throttled notify (150 ms + rAF)   (message-window-store.ts:65)
  → useMessages / useSyncExternalStore(hooks/queries/useMessages.ts:53)
  → SessionChat
      → normalizedMessages            (SessionChat.tsx:280)         [cached per message, NEW array每次]
      → reduceChatBlocks              (chat/reducer.ts:32)          [FULL recompute]
      → reconcileChatBlocks           (chat/reconcile.ts:220)       [identity restore — flat blocks only]
      → buildVisibleChatBlocks        (chat/toolGroups.ts:355)      [NO identity restore]
  → useHappyRuntime                   (lib/assistant-runtime.ts:210)
  → useExternalMessageConverter       [WeakMap cache — misses on every tool group]
  → ThreadPrimitive.Messages          (AssistantChat/HappyThread.tsx:749) [renders EVERY message]
```

The key observation: `reconcile.ts` exists specifically to undo the identity churn created by `reducer.ts`. It succeeds for flat blocks — and stops one step short of the tool groups, which is where tool-heavy sessions spend their time.

---

## 3. P0 — dominant costs

### 3.1 O(N²) selector in `AssistantMessage`

`web/src/components/AssistantChat/messages/AssistantMessage.tsx:89-105`:

```ts
const forkSeq = useAssistantState(({ message, thread }) => {
    const messages = thread.messages
    const idx = messages.findIndex((m) => m.id === message.id)   // O(N)
    for (let i = idx + 1; i < messages.length; i++) { ... }       // O(N)
})
```

and `:106-108`:

```ts
const isLastMessage = useAssistantState(({ message, thread }) => thread.messages.at(-1)?.id === message.id)
```

`useAssistantState` is `useSyncExternalStore`, so React re-invokes **every subscriber's `getSnapshot` on every store notification**. Both selectors read `thread.messages`, so every mounted assistant message performs a linear scan per notification.

- 400-message window: ~160 k comparisons per notification
- 2400-message history window: ~5.8 M comparisons per notification

**Fix direction:** compute `forkSeq` once per pipeline pass in `SessionChat` (a single O(N) sweep) and write it into block metadata. `isLastMessage` should compare against a `lastMessageId` primitive, not the array.

### 3.2 Tool-group objects are rebuilt every tick and never reconciled

`web/src/chat/toolGroups.ts:410-422` always constructs a brand-new `ToolGroupBlock` (new `tools` array, new `summary` object). `previousGroups` is used only to keep the group **id** stable (`toolGroups.ts:314-323`), never the object identity.

`reconcile.ts` does not handle `tool-group` at all — grouping happens *after* reconcile (`SessionChat.tsx:361-367`).

Additionally, `reduceChatBlocks` always returns a fresh array (`chat/reducer.ts:186`, `dedupeAgentEvents(foldApiErrorEvents(...))`), so `reconciled.blocks` has a new array identity every time even when nothing changed — which guarantees the `visibleBlocks` memo re-runs.

Consequence chain:

1. new `ToolGroupBlock` identity
2. → `useExternalMessageConverter` WeakMap misses (`lib/assistant-runtime.ts:221`)
3. → new `ThreadMessageLike` + `new Date()` per group
4. → every `ToolGroupCard` in the window re-renders

### 3.3 `ToolGroupCard` is not memoized

`web/src/components/ToolCard/ToolGroupCard.tsx:123` — plain function component. `ToolCard` is the only memoized component in the chat tree (`ToolCard.tsx:593`).

Unmemoized work in its body, per render:

- `formatPrimaryTitle` (`:238` → `toolGroups.ts:434`) — re-derives the action kind of the latest tool
- `formatSubtitle` (`:239` → `:56-80`) — builds an array + 6 `t()` interpolations
- `runningFrom` — `tools.reduce(...)` over all tools (`:241-245`)
- when expanded, maps all tools with `getInputStringAny` + `resolveDisplayPath` per row (`:313-341`)

A 100-step Claude session may hold 20 groups of 5–30 tools each. All of them re-render every 150 ms during streaming.

### 3.4 Unstable chat context invalidates every consumer

`web/src/components/AssistantChat/HappyThread.tsx:801` passes an **inline object literal** to `HappyChatProvider`. New identity on every `HappyThread` render — and `HappyThread`'s props include `messagesVersion`, `pendingCount`, `isLoadingMoreMessages`, all of which change per tick.

Every `useHappyChatContext()` consumer therefore re-renders unconditionally: `HappyToolMessage` (`ToolMessage.tsx:171`), `HappyNestedBlockList` (`:61`), `HappyAssistantMessage` (`AssistantMessage.tsx:73`), `HappyUserMessage` (`UserMessage.tsx:64`), `ToolCardInner` (`ToolCard.tsx:366`), `ToolGroupCard` (`:128`).

This multiplies with §3.3: **fixing tool-group identity alone will not help while this context keeps invalidating every card.** Both must be fixed together.

### 3.5 SSE is unbatched and `mergeMessages` re-sorts the whole window per frame

`web/src/hooks/useSSE.ts:490-492`:

```ts
if (event.type === 'message-received') {
    ingestIncomingMessages(event.sessionId, [event.message])
}
```

One frame → one full pipeline run. `mergeMessages` (`lib/messages.ts:35-91`) is **not** an ordered merge; it is dedupe-by-id followed by a full `Array.prototype.sort` (`:89`), including on the two early-exit paths (`:38`, `:41`).

Per call it allocates roughly six n-sized structures: a `Map` (`:43`), `Array.from` (`:51`), a `Set` (`:53`), an optional `.filter` (`:62`), two more `.filter` passes (`:72`, `:73`), and a spread (`:74`). `compareMessages` (`:21-33`) falls back to `a.id.localeCompare(b.id)`, which is far slower than `<`/`>`.

There is also a bounded O(opt × n) branch at `:76-87` (`nonOptimisticMessages.some(...)` inside a loop over optimistic messages).

When the user is scrolled up, one SSE frame invokes `mergeMessages` **three times** (`message-window-store.ts:786` agents, `:391` pending, `:809` latest-page cache), plus `filterPendingAgainstVisible` (`:359`) building a Set of all visible ids and `deriveSeqBounds` (`:212`) re-scanning everything in `buildState`.

### 3.6 `reduceChatBlocks` is a full recompute with ~10 passes

`web/src/chat/reducer.ts:32-187`, triggered whenever `normalizedMessages` or `props.session.agentState` changes (`SessionChat.tsx:338-341`). `normalizedMessages` always returns a fresh array (`SessionChat.tsx:280-308` has no "nothing changed" early-out).

| Line | Work |
|---|---|
| `:36` | `getPermissions` — rebuilds Map from agentState |
| `:37` | `collectToolIdsFromMessages` — O(N × blocks) |
| `:38` | `collectTitleChanges` — O(N × blocks) |
| `:40` | `traceMessages` — O(N), allocates `{...message}` per message (`tracer.ts:74`, `:96`, `:107`, `:119`) |
| `:44-52` | group/root partition — O(N) + new Map |
| `:57` | `reduceTimeline` — allocates a brand-new `ChatBlock` for every text / reasoning / event / tool |
| `:63-65` | `Math.min(...normalized.map(...))` — spreads N args into `Math.min`; wasted allocation and a stack-overflow risk at large N |
| `:106` | `blocks.sort(...)` — full O(B log B) sort every tick |
| `:119-139` | usage sweep 1 — O(N) |
| `:140-184` | usage sweep 2; `:144` does `normalized.slice(0, i).reverse().find(...)` — two i-sized allocations |
| `:186` | `foldApiErrorEvents` + `dedupeAgentEvents` — two more passes; `dedupeAgentEvents` runs `JSON.stringify(event)` per agent-event block (`reducerEvents.ts:84`) |

Inside `reduceTimeline`:

- `msg.content.find(c => c.type === 'tool-call' && c.name === 'Task')` runs for **every** agent message (`reducerTimeline.ts:117`), though almost none contain a Task.
- `scoreToolResultContent` (`:8-41`) recursively walks tool-result payloads to depth 3, **twice per tool result** (`:275`, `:276`), from scratch every tick. This is the most expensive per-tool work in the reducer.
- `mergeCliOutputBlocks` (`:293`) is another full pass with two regex tests per cli-output block.

In `reconcile.ts`, `getEventKey`'s default branch does `JSON.stringify(event)` (`:94-98`) per unrecognized event type, per tick, and `reconcileChatBlocks` rebuilds the whole `byId` Map recursively every tick (`:224-227`).

**Second trigger:** `mergeSessionResponse` (`lib/session-cache.ts:89-90`) returns `{ session: patch }` — a complete replacement. Any `session-updated` SSE gives `agentState` a new identity and forces a full reduce **even when its contents are byte-identical**. `thinking` toggles frequently, so this fires often.

### 3.7 assistant-ui chunking merges a whole agent turn into one message

`chunkExternalMessages` (`@assistant-ui/react/.../external-message-converter.js:113-153`) merges *consecutive* assistant/tool outputs into a single thread message. Only `user-text`, `cli-output(user)` and `agent-event` (role `system`) break a chunk.

So an agent turn with 200 tool calls becomes **one** assistant `ThreadMessage` with 200 content parts. When a new block lands at the end, `shallowArrayEqual(cached.outputs, m.outputs)` fails (`:201`) and `joinExternalMessages` re-walks and re-spreads all 200 parts (`:12-111`, note the `{...c, [symbolInnerMessage]: [output]}` spread at `:43-46`). **All 200 part objects get new identities.**

This is why long consecutive tool runs degrade far worse than the same number of separate messages.

---

## 4. P1 — significant

### 4.1 Markdown is re-parsed on every render

The parse is **not** memoized: `MarkdownTextPrimitive` → `<ReactMarkdown>{text}</ReactMarkdown>` (`@assistant-ui/react-markdown/.../MarkdownText.js:41`) runs the full unified pipeline (remark parse → gfm / breaks / math / two custom plugins → rehype → katex) synchronously in render, every render.

Worse, the memoization that *does* exist is expensive (`@assistant-ui/react-markdown/.../memoization.js:3-21`):

```js
const areChildrenEqual = (prev, next) => {
    if (typeof prev === "string") return prev === next;
    return JSON.stringify(prev) === JSON.stringify(next);   // deep compare of the hast subtree
};
```

For a large paragraph, table or code block this comparison costs more than re-rendering. Combined with §3.4 (context invalidates every tick), **all markdown in the window is re-parsed on every tick.**

Plugin arrays themselves are module-level constants (`markdown-text.tsx:23-24`) — that part is correct.

### 4.2 `useSmooth` is enabled by default

`MarkdownTextInner` defaults `smooth = true` (`MarkdownText.js:12`). Neither `markdown-text.tsx:261-270` nor `MarkdownRenderer.tsx:19-24` passes `smooth={false}`.

`useSmooth` (`@assistant-ui/react/.../useSmooth.js:29-51`) drives a `requestAnimationFrame` loop revealing ~200 chars/sec, calling `setDisplayedText` per frame — i.e. **a full markdown re-parse plus the §4.1 deep compares at up to 60 fps** for any text part that grows in place. It also adds a `useAssistantState` subscription and a `useState` per markdown part.

Today most blocks arrive complete, so the animator largely no-ops. This is latent: one move to true server-side token streaming makes it the dominant cost.

### 4.3 Shiki: 31 chunks fetched eagerly at module evaluation

`web/src/lib/shiki.ts:9-52`:

```ts
const THEMES = [ import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark') ]
const LANGS  = [ import('@shikijs/langs/shellscript'), /* …29 total… */ ]
```

These `import()` expressions sit in array literals evaluated at **module-evaluation time**, not inside `getHighlighter()`. `shiki.ts` is statically imported by `shiki-highlighter.tsx` ← `markdown-text.tsx` ← every message component, so **all 31 chunks begin downloading as soon as the chat bundle loads, even if no code block is ever rendered.**

`getHighlighter()` (`:105-114`) does correctly memoize the singleton.

Highlighting itself is debounced 150 ms and async (`:126-176`) with graceful plaintext fallback — but it has **no result cache** (remount re-highlights) and **no length cap**; `codeToHast` + `toJsxRuntime` block the main thread while they run, and a multi-hundred-KB tool output goes straight through. `ToolCard/views/_results.tsx` applies no truncation either.

### 4.4 No virtualization

No `react-virtual` / `react-window` / `react-virtuoso` / custom windowing anywhere in `web/src` or `web/package.json`.

`ThreadPrimitive.Messages` (`HappyThread.tsx:749`) renders every message (`ThreadMessages.js:99-107`). The only bound on DOM size is the store window: 400 normally, 2400 while browsing history. Each mounted message holds 9–11 live `useSyncExternalStore` subscriptions.

The only mitigation in place is CSS (`web/src/index.css:297-300`):

```css
.happy-thread-messages > * {
    content-visibility: auto;
    contain-intrinsic-size: auto 80px;
}
```

That helps paint/layout but does nothing for React reconciliation or selector cost.

Also note this universal selector, which must be matched against every node in the subtree on each style recalculation (`index.css:281-284`):

```css
.chat-viewport .chat-content,
.chat-viewport .chat-content * { max-width: 100%; }
```

### 4.5 `visibleUserMessages` re-normalizes the whole window, uncached

`SessionChat.tsx:315-325` calls `buildUserMessageItem` → `normalizeDecryptedMessage` for every message, **bypassing `normalizedCacheRef`** which already computed the identical result at `:280-308`. It also sorts every time, and runs whether or not the user panel is open.

The unrecognized-envelope fallbacks in `normalize.ts` (`:24`, `:40`, `:62`, `:75`) call `safeStringify` — `JSON.stringify(value, null, 2)` of the entire raw payload — so this second uncached pass pretty-prints those payloads again on every tick.

`messageHasNormalText` (`message-window-store.ts:562-574`) has the same uncached-normalize problem in the load-older path.

### 4.6 `handleSend` depends on the whole `props` object

`SessionChat.tsx:503`:

```ts
}, [props, slashCommands, addToast, agentFlavor, haptic, t])
```

`props` is a new object on every parent render, so `handleSend` is never stable → `onNew` re-created (`assistant-runtime.ts:231`) → `adapter` memo invalidated (`:239-256`) → `useExternalStoreRuntime` receives a new adapter and pushes a new snapshot to every subscriber. This largely defeats the runtime's memoization design.

`props.session.thinking` is also in the adapter deps (`:224`, `:251`), so every thinking toggle re-creates the adapter as well.

### 4.7 Window grows unbounded while reading history

`message-window-store.ts:779-797`: when not at bottom, agent messages are inserted immediately and `trimVisible(merged, 'prepend')` does not trim below `PREPEND_HARD_MAX = 2400` (`:322-327`).

So while a user scrolls back to read, a still-running agent keeps inflating the window, and every new message re-sorts and re-reduces the whole thing. **The longer the user reads, the slower it gets.**

(Note: lines `:779-780` carry Chinese comments, which conflicts with the project's English-only rule for engineering artifacts.)

---

## 5. Correctness issues

### 5.1 Rules-of-Hooks violation in `UserMessage.tsx`

```
UserMessage.tsx:108      if (role !== 'user') return null
UserMessage.tsx:116-124  if (isCliOutput) return (...)
UserMessage.tsx:129      const [summaryExpanded, setSummaryExpanded] = useState(false)          // after early returns
UserMessage.tsx:131      const [stopHookFeedbackExpanded, setStopHookFeedbackExpanded] = useState(false)
```

If `role` or `isCliOutput` ever flips between renders, React throws *"Rendered more hooks than during the previous render."* Plausible triggers: an optimistic bubble being replaced by the server echo, or `meta` arriving late and changing the `cli-output` classification.

### 5.2 Reconnect backfill can silently lose messages

`App.tsx:207-209` (`handleSseConnect`) calls `fetchLatestMessages(api, selectedSessionId)`, which fetches `PAGE_SIZE = 50` with `beforeSeq: null` (`message-window-store.ts:461`).

A disconnect spanning more than 50 messages leaves a **silent gap** — there is no `afterSeq`-based catch-up on reconnect. The user sees a discontinuous thread until they manually scroll.

### 5.3 Trim does not notify other clients

`SessionChat.tsx:674-692` calls `clearMessageWindow` + refetch locally, but the hub emits no SSE event after a trim (see §7.5). Other connected clients keep a stale window.

---

## 6. Scroll logic

`HappyThread.tsx` implements a hand-rolled scroll controller using ~25 refs and **eight concurrent mechanisms**:

| Mechanism | Location |
|---|---|
| scroll / wheel / touch / pointer / keydown intent tracking | `:184-296` |
| `ResizeObserver` on content height | `:332-354` |
| `useLayoutEffect` on `messagesVersion` | `:656-663` |
| double-`requestAnimationFrame` on `isLoadingMore` transition | `:665-689` |
| `scheduleCleanup` — 50 ms polling + 1000 ms timeout | `:540-565` |
| `pendingGoLatest` layout effect | `:425-445` |
| `suspendAutoLoadNewer` layout effect | `:447-461` |
| top `IntersectionObserver` | `:628-654` |

They coordinate only through refs; there is no single state machine.

### 6.1 `scheduleCleanup` polls for render completion

`HappyThread.tsx:540-565`:

```ts
const check = () => {
    if (isLoadingMoreRef.current) return
    const landed = baseline !== null && messagesVersionRef.current !== baseline.messagesVersion
    if (pendingScrollRef.current && (landed || Date.now() - startedAt > 1000)) { ... }
    setTimeout(check, 50)
}
```

The inline comment states the root cause: store notifications are throttled, so "fetch finished" and "React committed" are decoupled, and the only available signal is polling.

`notifyImmediate` already exists (`message-window-store.ts:186`) and is used by `flushPendingMessages`, `setAtBottom`, `appendOptimisticMessage` and `clearMessageWindow` — but **not** by `fetchOlderMessages`. Routing prepend completion through it would remove the poll entirely.

### 6.2 Bottom threshold is 2 px

`HappyThread.tsx:188`: `const BOTTOM_THRESHOLD_PX = 2`.

Browser zoom, sub-pixel rounding and mobile inertial scrolling can all leave `distanceFromBottom` at 2–4 px, so `followBottomRef` never latches and the "new messages" pill stays pinned. Common practice is 50–100 px.

### 6.3 Anchor computation forces O(N) synchronous layouts

`HappyThread.tsx:507-512`:

```ts
const anchor = Array.from(messageContainer.children).find((child) =>
    child.getBoundingClientRect().bottom >= viewportTop
)
```

One forced layout per child — 400 children means 400 forced layouts. `restorePendingAnchor` (`:302-308`) additionally re-runs `querySelector('.happy-thread-messages')` and `Array.from(children).find(...)` on every call, and it is called many times during a single prepend (ResizeObserver + layout effect + double rAF + the cleanup poll).

**Fix direction:** hold `messageContainer` in a ref; binary-search on `offsetTop` (monotonic across children) instead of a linear `getBoundingClientRect` scan.

### 6.4 `content-visibility: auto` fights the manual anchor

`contain-intrinsic-size: auto 80px` means unrendered messages are 80 px placeholders. Scrolling toward them expands their real height → `scrollHeight` jumps → `ResizeObserver` fires (`:338-348`) → if `followBottomRef` is set, the viewport snaps to the bottom. Native anchoring is disabled (`index.css:278`, `overflow-anchor: none`), so nothing absorbs the delta.

Commit `b0711894 fix(web): stop chat viewport jumps on load-older and streaming` appears to target this class of problem; residual interactions remain likely.

### 6.5 One "load older" click can trigger 20 round-trips and 20 full recomputes

`message-window-store.ts:28` (`OLDER_SKIP_TOOL_ONLY_MAX_PAGES = 20`) and `:595-634`: the loop keeps fetching while pages contain only tool activity, and calls `updateState` **inside** the loop.

The intent (don't leave the reader staring at "Load older + tool groups only") is sound, but the cost is up to 20 serial round-trips, 20 full pipeline recomputes, and 20 anchor restorations for a single click. This is the direct cause of "load older is very slow" in tool-dense sessions.

**Fix direction:** have the server return "back to the previous normal-text message" in one call, or at minimum hoist `updateState` out of the loop.

### 6.6 `jumpToUserMessage` busy-waits

`SessionChat.tsx:639-646` polls `document.getElementById` 30 times at 16 ms intervals (~500 ms worst case). A `MutationObserver`, or a store callback fired when the focus window commits, would be deterministic.

---

## 7. Backend (`hub/`)

### 7.1 `hasMore` is computed with an extra `SELECT *`

`hub/src/sync/messageService.ts:270-272`:

```ts
const hasMore = nextBeforeSeq !== null
    && this.store.messages.getMessages(sessionId, 1, nextBeforeSeq, options.role).length > 0
```

This reads and `JSON.parse`s the **full content blob of the next message** — potentially hundreds of KB of tool output — purely to test existence, then discards it. The forward twin is at `:305-307`.

Three different `hasMore` strategies coexist in the codebase: this probe, `LIMIT n+1` in `getMessagesSince` (`store/messages.ts:348`), and `messages.length === limit` in the share route (`web/routes/share.ts:116`).

### 7.2 No HTTP compression

No `compress` middleware anywhere in `hub/src`. The messages endpoint returns raw, untruncated agent payloads (`content` is `z.unknown()`, `shared/src/schemas.ts:202-208`) with no field projection. Fifty messages can be several MB of JSON.

**This is very likely the single largest first-paint cost, and a one-line middleware fixes 70–90 % of it.** There is also no `Cache-Control`/`ETag` on `/api/sessions/:id/messages`.

### 7.3 The user-message panel issues up to 2000 serial requests

`SessionChat.tsx:520` loops up to `HISTORY_FETCH_MAX_PAGES = 2000` at `HISTORY_FETCH_PAGE_SIZE = 200`, serially.

The index is fine — `idx_messages_session_role_seq (session_id, role, seq)` (`hub/src/store/index.ts:346`) is a perfect left-prefix match, and `role` is materialized at insert time. The problems are elsewhere:

- The server does `SELECT *`, returning full `content`, while the UI only builds a 180-character preview (`SessionChat.tsx:74`) — **10–100× payload waste**.
- Every page also pays the §7.1 probe → 2000 pages means ~4000 queries.
- No server-side page cap and no rate limiting on this route.

`MessageService.getSessionHistory` (`sync/messageService.ts:100-148`) already returns `{role, text}` instead of full content and batches server-side — but it is exposed only on `/cli` (`web/routes/cli.ts:217`). A `GET /api/sessions/:id/user-messages` returning `{id, seq, createdAt, text}` would collapse 2000 requests into one.

### 7.4 Unbounded `LIKE` scan on the sessions list

`hub/src/store/messages.ts:129-136`:

```sql
SELECT content FROM messages
WHERE session_id = ? AND role = 'assistant' AND content LIKE '%"total_cost_usd"%'
ORDER BY seq DESC
```

No `LIMIT`. `sessionTotalCost` calls this for **every session in the namespace** on every `/api/sessions` request (`web/routes/sessions.ts:174`), materializes all matches into JS, then almost always returns on the first iteration (`store/messages.ts:138-147`). `LIMIT 1` is exactly equivalent.

This path is **not** covered by `sessionCostCache` (only the fallback path is, `sessions.ts:19`, `:68`).

Since SQLite here is synchronous, single-connection and on the same thread as the HTTP server (`store/index.ts:100-104`), this scan directly stalls SSE delivery.

Related: the fallback loop calls `getMessages(session.id, Math.max(200, session.seq + 1))`, but `Math.min(200, limit)` at `store/messages.ts:105` silently clamps it — so token totals are computed from only the last 200 messages.

### 7.5 SSE has no batching and serializes per connection

`hub/src/web/routes/events.ts:88`:

```ts
send: (event) => stream.writeSSE({ data: JSON.stringify(event) })
```

`SSEManager.broadcast` (`sse/sseManager.ts:107-117`) is a synchronous loop: one frame per event per connection, no debounce, no buffer. `JSON.stringify(event)` runs **once per connection** instead of once per event.

The payload is the entire message record, not a delta (`socket/handlers/cli/sessionHandlers.ts:139-149`).

For contrast, two things *are* optimized: session-alive updates coalesce to ≤1 broadcast per 10 s (`sync/sessionCache.ts:253-271`), and toasts skip hidden connections (`sse/sseManager.ts:79-81`). **`message-received` gets neither** (`sseManager.ts:166-168`) — background tabs receive every message at full size.

### 7.6 Storage and ingest

- `content` is JSON serialized into a TEXT column (`store/messages.ts:73`); every read pays a full `JSON.parse`, and `c.json()` immediately re-serializes it.
- **No size limit at all** on `content` — the socket ingest validator is `z.union([z.string(), z.unknown()])` (`socket/handlers/cli/sessionHandlers.ts:33-37`). The 50 MB `bodyLimit` covers only `/cli/*` HTTP routes.
- Every message body is duplicated into the FTS5 index (`store/index.ts:349-361`), roughly doubling storage and making inserts/deletes materially more expensive.
- `seq` allocation is an untransacted read-then-write (`store/messages.ts:67-89`) — a per-insert aggregate query, racy under concurrent writers.
- `addMessage` re-reads the row it just inserted (`store/messages.ts:91`) to build a return value it already had.
- Bulk `trim` fires one FTS5 delete trigger per row synchronously, blocking the event loop.
- A debug `console.log` runs on every trim request (`web/routes/messages.ts:89-91`).
- No server-side normalization or summarization exists — raw agent content is stored and shipped verbatim; all normalization is client-side.
- `/api/sessions/:id/messages` has no tool-call boundary repair, unlike the share route (`web/routes/share.ts:118-137`), so a page can end on an orphaned `tool_use`.

---

## 8. Secondary findings

| # | Issue | Location |
|---|---|---|
| S1 | `ElapsedView` runs a 1 s `setInterval` per running tool, re-rendering the whole `ToolCardInner` each tick | `ToolCard.tsx:42-61`, `:417`; `ToolGroupCard.tsx:275`, `:328` |
| S2 | Static view uses `<details>`/`<summary>`, so collapsed tool bodies still render — the shared-session page Shiki-highlights every tool's full input and result up front | `ToolCard.tsx:486-500` |
| S3 | `ToolCard` is memoized but its body rebuilds `renderTaskSummary` (`:386`), three view-component lookups (`:389-391`), and `fullBody` (`:443-462`) on every render — `fullBody` is only used once the dialog opens | `ToolCard.tsx` |
| S4 | `createToolGroupId` does two linear `previousGroups.find(...)` per group → O(G²) | `toolGroups.ts:314-319` |
| S5 | `pushUnique` uses `Array.includes` → `summarizeToolGroup` is O(k²) in distinct targets; `getToolGroupActionKind` runs ~15 string comparisons per tool per tick | `toolGroups.ts:65-69`, `:91-178`, `:236-266` |
| S6 | `LazyRainbowText` runs `text.toLowerCase()` (full-string allocation) plus up to 18 `includes()` on every render, unmemoized | `LazyRainbowText.tsx:157` |
| S7 | Voice hooks build `new Set(prev.map(m => m.id))` and filter the whole window on every messages change, regardless of whether voice is active | `SessionChat.tsx:209-218` |
| S8 | `safeStringify` pretty-prints the entire tool input on every tool-block conversion (cache miss) — for `Write`/`MultiEdit` that is the whole file | `assistant-runtime.ts:134`; `ToolCard.tsx:242` |
| S9 | Throttle sentinel `notifyRafId = -1 as unknown as ...`; the paired `setTimeout` is never cancelled on teardown | `message-window-store.ts:77-82` |
| S10 | `ToolGroupCard` renders a Radix `<Dialog>` unconditionally, open or not | `ToolGroupCard.tsx:373-388` |
| S11 | `mergeMessages` sorts even on the `existing.length === 0` fast path, though inputs are already ordered | `lib/messages.ts:36-38` |
| S12 | `isSkippableAgentContent` repeats the same guards `normalizeAgentRecord` runs again — two full guard passes per agent message | `normalize.ts:47`; `normalizeAgent.ts:335`, `:356-363` |

---

## 9. Code style / maintainability

| Issue | Location |
|---|---|
| `SessionChat.tsx` is 929 lines mixing normalization, the user-message panel, voice integration, config-mutation serialization, trim mode, slash-command handling and a clipboard fallback. At minimum `UserMessagePanel`, `useVoiceBridge` and `useSlashCommandHandler` should be extracted. | whole file |
| `HappyThread` takes 33 props and holds ~25 refs; the scroll state belongs in a reducer or explicit state machine. | `HappyThread.tsx:62-142` |
| Chinese comments violate the project's English-only rule for engineering artifacts. | `message-window-store.ts:779-780` |
| Two duplicate session-change cache-clearing paths — a `useEffect` and a `prevSessionIdRef` check inside a `useMemo`. | `SessionChat.tsx:263-267` vs `:281-286` |
| `let hasReadyEvent` is never reassigned. | `reducer.ts:58` |
| `routes/shared-session.tsx:148` duplicates the SessionChat pipeline (its own comment says "same pipeline as SessionChat") — two copies to maintain. | `routes/shared-session.tsx` |
| Three different `hasMore` implementations across the backend. | see §7.1 |

---

## 10. Recommended order of work

### Tier 1 — one-line to one-function changes, immediate payoff

1. Wrap the `HappyChatProvider` value in `useMemo` — `HappyThread.tsx:801`. **Best single-point return in the whole list.**
2. Pass `smooth={false}` — `markdown-text.tsx:263`, `MarkdownRenderer.tsx:19`.
3. Move the `import()` calls inside `getHighlighter()` — `lib/shiki.ts:9-52`.
4. Add `hono/compress` to the hub.
5. Add `LIMIT 1` to `getClaudeReportedCost` — `store/messages.ts:129`.
6. Switch `hasMore` to `limit+1` — `messageService.ts:270`, `:305`.
7. Replace `pushUnique`'s `Array.includes` with a `Set` — `toolGroups.ts:65`.
8. Raise `BOTTOM_THRESHOLD_PX` from 2 to ~64 — `HappyThread.tsx:188`.
9. Drop the bare `props` from `handleSend`'s dep array — `SessionChat.tsx:503`.
10. Remove the debug `console.log` — `hub/src/web/routes/messages.ts:89`.

### Tier 2 — correctness

11. Move the two `useState` calls above the early returns — `UserMessage.tsx:129`, `:131`.
12. Make reconnect backfill `afterSeq`-based so gaps > 50 messages are filled — `App.tsx:207`.
13. Emit an SSE event after `trim` so other clients invalidate.

### Tier 3 — targeted performance work (≈1–2 days)

14. Precompute `forkSeq` once per pipeline pass into block metadata; compare `isLastMessage` against a primitive — `AssistantMessage.tsx:89-108`.
15. Extend reconcile to tool groups (reuse the prior object when `firstToolId`/`lastToolId` and all tool identities match) **and** add `React.memo` to `ToolGroupCard`, `HappyAssistantMessage`, `HappyUserMessage`.
16. Micro-batch `ingestIncomingMessages` on a 16 ms rAF window.
17. Replace `mergeMessages`' Map+sort with an ordered merge — both inputs are already seq-ordered — and drop `localeCompare` from the tiebreak.
18. Reuse `normalizedCacheRef` in `visibleUserMessages`; make it lazy until the panel opens — `SessionChat.tsx:315`.
19. Add an LRU cache and a length cap to `useShikiHighlighter`.
20. Hoist `updateState` out of the load-older loop — `message-window-store.ts:595`.

### Tier 4 — architectural

21. Make `reduceChatBlocks` incremental: track `lastReducedSeq` and reduce only the appended tail.
22. Introduce list virtualization (or bound the mounted set to the last N messages with upward expansion).
23. Replace `scheduleCleanup`'s 50 ms poll with `notifyImmediate` on prepend commit, and collapse the eight scroll mechanisms into one state machine — `HappyThread.tsx:540`.
24. Add `GET /api/sessions/:id/user-messages` to replace the 2000-request loop.
25. Batch SSE broadcasts, serialize once per event rather than per connection, and honour the visibility check for `message-received`.
26. Suppress the §3.7 chunk-rebuild amplification (upstream `@assistant-ui/react`) — either by inserting chunk boundaries between tool groups or by pinning the library version and patching `joinExternalMessages`.

---

## 11. Suggested measurement before/after

No profiling was performed for this review. Before committing to Tier 3–4, capture a baseline:

- React Profiler flame chart during a 30-tool-call burst at 400 and at 2000 messages in the window.
- `performance.measure` around `reduceChatBlocks`, `buildVisibleChatBlocks` and `mergeMessages`.
- Long-task count from `PerformanceObserver` (`longtask`) over a streaming minute.
- Network panel: transfer size of the first `GET /messages` page, and the count of Shiki chunk requests on a session with zero code blocks.

The Tier 1 items are cheap and low-risk enough to land without a baseline; the rest should be justified by measurements.
