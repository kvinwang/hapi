# Session Page Performance and UX Review

## Scope

Read-only review of the session page, including message ingestion, pagination, scroll behavior, rendering, long histories, and consecutive tool-call workloads. The review covers the web message pipeline and relevant hub behavior.

## Findings

### High-impact findings

| Priority | Area | Finding | User impact | Recommendation |
|---|---|---|---|---|
| High | `web/src/hooks/useSSE.ts` | Every `message-received` SSE event is ingested independently. Each ingestion merges and sorts the visible message window. Tool-call bursts can therefore repeat whole-window work many times per frame. | Main-thread stalls, delayed input, and dropped frames during rapid tool activity or streaming bursts. | Batch incoming messages per session over a short frame-sized interval, then perform one store update per batch. Preserve immediate handling only where latency is user-visible. |
| High | `web/src/lib/messages.ts` | `mergeMessages(existing, [])` creates and sorts a new array even though no data changed. Array identity changes can advance downstream versions and invalidate memoized computations. | Unnecessary normalization, reduction, conversion, and React rendering. Cost grows with history size. | Return the existing array when incoming messages are empty. More generally, preserve identity whenever a merge produces no semantic change. |
| High | `web/src/components/SessionChat.tsx` | User-message panel derivation normalizes raw messages separately from the main normalized-message pipeline. | Duplicate O(n) parsing and allocation on each relevant update. | Derive user-panel entries from the cached normalized-message list, or maintain a separate incremental user-message index. |
| High | `web/src/components/ToolCard/ToolGroupCard.tsx` and `HappyThread.tsx` | Native scroll anchoring is disabled for the chat viewport. Expanding or collapsing a tool group above the visible reading position changes content height without compensating `scrollTop`. | The viewport appears to jump even though the user did not scroll. Large tool groups produce large jumps. | Capture a stable visible anchor before toggling and restore it after layout. Centralize height-change compensation in the thread scroll controller rather than implementing competing local controllers. |

### Medium- to high-impact findings

| Priority | Area | Finding | User impact | Recommendation |
|---|---|---|---|---|
| Medium-high | `web/src/chat/reducer.ts` and `SessionChat.tsx` | `reduceChatBlocks` rebuilds the full block timeline when normalized messages or agent state change. Streaming updates can trigger this repeatedly over a large window. Sorting and usage scans are also repeated. | Likely the largest remaining CPU cost during active streaming, especially with hundreds or thousands of raw messages. | Introduce incremental reduction keyed by message identity/version. At minimum, separate stable historical blocks from the mutable tail and recompute only the tail. Benchmark before and after with realistic histories. |
| Medium-high | `web/src/chat/toolGroups.ts` | Tool grouping and summary generation scan tool runs repeatedly. Unique-target collection uses array `includes`, which becomes quadratic for groups containing many distinct targets. | Long consecutive tool-call runs become increasingly expensive to summarize and regroup. | Use `Set` for uniqueness, cache summaries by stable tool identities/state, and recompute only groups intersecting the mutable tail. Consider a compact representation for very large groups. |
| Medium-high | Message window policy | The visible store can grow well beyond the nominal 400-message target during history prepends, up to a hard limit derived from `VISIBLE_WINDOW_SIZE * 6`. This protects scroll continuity but increases all downstream full-list work. | Memory growth and increasingly expensive normalization/reduction/render conversion during deep history browsing. | Separate the logical loaded window from the mounted/rendered window. Use stable-anchor virtualization or segmented history pages so old content can remain logically available without keeping all DOM and reducer output active. |
| Medium-high | `web/src/lib/message-window-store.ts` | `mergeMessages` constructs maps, scans optimistic messages, and sorts the complete merged list for routine appends where incoming sequence numbers are usually monotonic. | Repeated O(n log n) work during streaming and tool-call bursts. | Add fast paths for monotonic append/prepend and same-ID replacement. Fall back to the general merge only for out-of-order or optimistic reconciliation cases. |
| Medium-high | Hub/web history pagination | The client uses a 50-message page and may issue up to 20 sequential requests while skipping tool-only pages. | High latency on weak networks and excessive request overhead for tool-dense history. | Return pages based on display usefulness or byte budget, increase limits for history hydration, or let the hub return a display-oriented page ending at a textual boundary. Keep response-size limits. |
| Medium | Hub SSE delivery | Messages are broadcast individually even when many arrive in a short burst. Client-side batching can reduce rendering work but not per-event network and parsing overhead. | Excessive event framing and JSON parsing with multiple clients or heavy tool output. | Support batched message events at the hub protocol level while retaining ordering and compatibility rules appropriate for the current no-backward-compatibility policy. |

### Scroll and loading correctness concerns

| Priority | Area | Finding | User impact | Recommendation |
|---|---|---|---|---|
| Medium | `HappyThread.tsx` | Scroll ownership is distributed across scroll listeners, layout effects, a `ResizeObserver`, load completion effects, go-to-latest logic, force-scroll tokens, and tool-group behavior. Several paths can write `scrollTop`. | Race conditions are difficult to reason about and can manifest as intermittent large jumps. | Model scrolling as an explicit state machine: `following-tail`, `reading-history`, `preserving-prepend-anchor`, `jumping-to-target`, and `settling-layout`. Permit one owner to write scroll position per state. |
| Medium | `HappyThread.tsx` | Anchor settling uses a small fixed number of animation frames. Async content such as syntax highlighting, fonts, images, dialogs, or tool details may change height later. | Delayed layout changes can move the reading position after the nominal load has settled. | Keep the stable anchor active until a short quiescence period with no observed size changes, bounded by a timeout. Avoid clearing it solely after two frames. |
| Medium | `HappyThread.tsx` | `BOTTOM_THRESHOLD_PX` is only 2px. Fractional pixels, mobile viewport resizing, and browser scaling can cause frequent at-bottom transitions. | New-message indicators or follow-tail state may flicker or disengage unexpectedly. | Use a modest hysteresis range, such as entering at-bottom within 8–16px and leaving only beyond a larger threshold. Validate on mobile browsers and scaled displays. |
| Medium | Message window and SSE interaction | Live assistant messages are inserted while the user reads history, whereas user messages may be placed in pending state. This asymmetric policy preserves agent visibility but continuously changes content below or around the reading window. | Layout activity and mental distraction during historical reading; potential anchor pressure during long streams. | Keep updates logically current but avoid mounting mutable tail updates into the historical viewport unless required. Present a live-tail indicator or isolated tail region. Define the product behavior explicitly. |
| Medium | Jump-to-message flow | The implementation polls the DOM for up to 30 attempts and calls `scrollIntoView` more than once. It relies on timing rather than an explicit render acknowledgment. | Occasional failed jumps or secondary motion after the target appears. | Have the message runtime expose a committed target anchor, then perform one controlled scroll after that render. Use `requestAnimationFrame` only for final layout stabilization. |

### Rendering and component concerns

| Priority | Area | Finding | User impact | Recommendation |
|---|---|---|---|---|
| Medium | Assistant runtime conversion | Even with converter caching, changes to visible block arrays and group identities may force broad runtime updates. | Large timelines may re-render more than the mutable content requires. | Verify block identity stability with React Profiler. Ensure unchanged blocks and tool groups retain object identity; isolate the streaming tail from historical message components. |
| Medium | Tool-group expansion | Expanding a large group mounts every tool row and its presentation computation at once. | Noticeable pause and a very tall DOM subtree for hundreds of tool calls. | Render an initial slice, provide incremental expansion, or virtualize rows inside large groups. Keep summary/error/running items readily accessible. |
| Medium | Tool presentation | Each expanded row derives presentation data, paths, labels, and result-dependent metadata. | Expensive initial expansion for large groups; repeated work when live tool state changes. | Memoize by tool object identity and metadata identity. Limit expensive result parsing until a detail dialog opens. |
| Medium | Markdown, syntax highlighting, and reasoning output | Rich assistant output can undergo expensive parsing and layout during streaming. | Typing/scroll jank and repeated height changes. | Throttle rich rendering of the active tail, use plain-text streaming followed by finalized rich rendering where acceptable, and cache parsed output by content identity. |
| Low-medium | Voice integration in `SessionChat.tsx` | New-message detection rebuilds a set from the previous message list and filters the current list. Voice stores are also re-registered as message/session references change. | Additional O(n) work on every message update, even when voice is inactive. | Gate work on active voice state and track the last processed sequence/id incrementally. |
| Low | `SessionChat.tsx` size and responsibilities | The component combines normalization, reduction, voice, history panel, jumping, composer configuration, session controls, and rendering. | Harder performance diagnosis and higher risk of broad re-renders from unrelated state. | Split data derivation, user-history navigation, voice integration, and thread rendering into focused hooks/components with narrow dependencies. |

## Recommended order of work

| Phase | Work | Success metric |
|---|---|---|
| 1 | Instrument realistic workloads: 400/1,000/2,400 raw messages; 100–500 consecutive tool calls; active streaming; history prepend. | React commit time, long tasks, merge/reducer duration, mounted node count, and scroll-anchor drift are recorded reproducibly. |
| 2 | Batch SSE ingestion and add monotonic merge fast paths. | Fewer store updates and materially lower scripting time during tool-call bursts without perceptible message latency. |
| 3 | Stabilize block/group identity and incrementally reduce only the mutable tail. | Historical blocks do not re-reduce or re-render during ordinary tail streaming. |
| 4 | Consolidate scroll behavior into a state machine with stable-anchor quiescence. | No viewport drift across prepend, group toggle, delayed content resize, jump-to-message, and live streaming scenarios. |
| 5 | Bound mounted history and very large tool groups through segmented rendering or virtualization. | DOM size and render time remain bounded while browsing deep histories. |
| 6 | Improve hub pagination and optional SSE batching. | Fewer requests and lower event overhead on tool-dense sessions and weak networks. |

## Suggested benchmark scenarios

| Scenario | Dataset/action | What to measure |
|---|---|---|
| Streaming tail | 400 visible messages, append/update 20 events per second for 30 seconds | Main-thread time, commits per second, dropped frames, bottom-follow accuracy |
| Tool-call burst | 300 consecutive tool calls with state transitions and results | SSE parse/ingest time, reducer/grouping time, time to interactive, group expansion latency |
| Deep history | Prepend 20 pages into a long session while preserving a visible anchor | Anchor drift in pixels, requests, total load time, peak DOM nodes and memory |
| Read history during stream | Stay 1–2 screens above the tail while assistant output continues | Unexpected scroll delta, content replacement, indicator behavior |
| Group toggle above viewport | Expand/collapse groups of 20, 100, and 500 tools above the reading position | Scroll delta and layout duration |
| Jump to old user message | Target outside the current window under concurrent streaming | Success rate, time to target, secondary post-jump movement |
| Mobile viewport | Repeat loading and streaming while keyboard/address bar changes viewport height | at-bottom stability, accidental tail jumps, visual viewport handling |

## Overall assessment

The current design contains explicit protections for difficult chat behaviors, but performance and scroll correctness are coupled across too many independent mechanisms. The largest likely performance cost is repeated whole-window derivation during streaming; the largest maintainability risk is distributed scroll ownership. The most effective direction is to make message processing incremental, keep historical object identity stable, batch burst traffic, bound mounted content, and centralize all scroll writes behind one explicit controller.
