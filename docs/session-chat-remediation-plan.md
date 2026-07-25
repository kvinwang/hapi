# Session Chat Performance and UX Remediation Plan

## Objective

Make the session chat responsive and scroll-stable for long histories and tool-heavy runs, while preserving message correctness across reconnects and multiple clients.

The validation deployment uses an isolated snapshot of the `tdxlab` HAPI database. It must never write to the production database or expose credentials in source files, logs, commits, or reports.

## Working Method

Each iteration tests one primary hypothesis:

1. Review the current code, history, baseline, and this result log.
2. Make one focused change.
3. Commit before verification.
4. Run type checks, relevant tests, benchmarks, and preview smoke tests.
5. Retain improvements; revert regressions; fix or skip crashes.
6. Record the result below.
7. Update the isolated validation deployment and preview after each completed phase.

Unmeasured static-review findings are candidates, not confirmed bottlenecks. Architectural work proceeds only when measurements justify it.

## Target Workloads

- 400, 1,000, and 2,400 raw messages.
- 100, 300, and 500 consecutive tool calls.
- 20 inbound message events per second for 30 seconds.
- Twenty history-page prepends.
- Reading history while the live tail continues streaming.
- Expanding tool groups of 20, 100, and 500 items above the viewport.
- Reconnecting after missing 10, 50, 51, 200, and 1,000 messages.

## Success Criteria

- Reconnect backfill has no sequence gaps.
- Ordinary tail updates do not broadly re-render stable historical messages.
- Inbound bursts produce at most one store commit per batch/frame.
- No sustained main-thread task exceeds 50 ms in the standard streaming scenario.
- A 400-message React commit normally stays within a 16 ms frame budget.
- A 2,400-message loaded history remains interactive without second-scale stalls.
- History prepend and tool-group toggles preserve the visible anchor within 2 px.
- Jump-to-message succeeds without secondary motion.
- Mounted DOM remains bounded when loaded logical history grows.

## Phase 0: Baseline and Regression Harness

- Add reproducible fixtures for the target workloads.
- Measure merge, normalization, reduction, grouping, runtime conversion, store notifications, React commits, DOM count, requests, and anchor drift.
- Record baseline results before performance changes.

## Phase 1: Correctness and Safe Cleanup

- Make `UserMessage` hook ordering unconditional.
- Replace reconnect latest-page refresh with complete `afterSeq` gap backfill.
- Define trim semantics and invalidate other clients when trim changes shared data.
- Remove debug output, non-English engineering comments, and stale timers.

## Phase 2: Reduce Update Frequency

- Micro-batch inbound SSE messages per session before merge/store work.
- Preserve message-array identity for no-op merges.
- Add monotonic append/prepend and same-ID replacement fast paths.
- Accumulate tool-only history pages and commit them once per load action.

## Phase 3: Stabilize Identity and Render Scope

- Stabilize `HappyChatProvider` values and runtime callbacks/adapters.
- Reconcile unchanged tool-group objects and memoize tool-group rendering.
- Replace per-message linear assistant selectors with one pipeline sweep and primitive selectors.
- Verify render scope using the React Profiler.

## Phase 4: Reduce Pipeline Cost

- Reuse normalized messages for the user-message panel, voice, and history checks.
- Gate inactive features and avoid repeated large-payload serialization.
- Split reduction into stable history plus a mutable tail, guarded by differential tests against full reduction.
- Cache repeated tool-result/event computations.
- Defer Shiki loading, cache bounded highlighting results, and avoid unnecessary smoothing.

## Phase 5: Consolidate Scroll Control

- Add scroll regression scenarios before changing behavior.
- Add bottom-state hysteresis and explicit prepend commit signals.
- Preserve a stable anchor across tool-group and asynchronous height changes.
- Replace polling and competing scroll writers with an explicit scroll state machine.

## Phase 6: Bound Mounted Content When Required

- First render very large tool groups incrementally.
- If Phase 0–5 measurements remain above targets, introduce segmented history rendering or variable-height virtualization with stable anchors.

## Phase 7: Hub and Network Optimizations

- Use `limit + 1` pagination without reading full content for existence probes.
- Add a lightweight user-message history endpoint.
- Improve tool-heavy history hydration by useful boundary or byte budget.
- Batch Hub SSE messages and serialize each batch once.
- Verify compression, session-cost queries, content limits, sequence allocation, FTS cost, and redundant reads independently.

## Validation Deployment

- Source: a consistent read-only snapshot from `tdxlab`.
- Destination: a dedicated local directory outside production HAPI data.
- Service: a dedicated local port and process/container name.
- Access: an ephemeral Cloudflare quick tunnel.
- Authentication: reuse only runtime-provided values; never copy credentials into this repository or reports.
- Promotion: rebuild, migrate the disposable snapshot if required, smoke-test, then update the preview after each completed phase.

## Results Log

| Date | Phase | Commit | Hypothesis | Verification | Result | Decision |
|---|---|---|---|---|---|---|
| 2026-07-25 | Setup | `ca39b876` | Persisting the plan and isolated validation procedure prevents long-running task drift. | `git show --check`; document existence check | Passed | Retained |
| 2026-07-25 | Validation baseline | N/A | A consistent production-sized snapshot can run safely in a dedicated local deployment. | SQLite online backup; `PRAGMA quick_check`; 1,159,297 messages; isolated port smoke test; production build | Passed | Retained |
| 2026-07-25 | Phase 0 | `f7db09b7`, `17e2ac91`, `48e727b1` | A production-data benchmark and opt-in browser instrumentation can establish reproducible pipeline and React baselines without retaining message content. | Web typecheck; instrumentation unit test; production build; 20-iteration 400/1,000/2,400-message benchmark | Passed; 2,400-message p95: merge 0.95 ms, normalize 4.38 ms, reduce 4.69 ms, group 2.33 ms | Retained |
| 2026-07-25 | Phase 1 | `14181ff0`, `ccd07ec2`, `bc2f29e8`, `cdaaa9fa` | Stable hooks, complete sequence catch-up, shared trim invalidation, and simpler notification scheduling remove identified correctness risks without pipeline regressions. | Full typecheck; message-window and SSE tests; production build; isolated deployment smoke test; production-data benchmark | Passed; full CLI suite separately exposed four unrelated environment/flaky integration failures while 399 tests passed | Retained |
| 2026-07-25 | Phase 2 | `9dd057ff`, `404af1ad`, `aa974f69`, `0d14e001` | Per-frame SSE batching, ordered merge fast paths, and one history commit reduce redundant full-window work. | Web typecheck; 18 focused tests; production build; isolated deployment smoke test; production-data benchmark | Passed; 2,400-message single-append merge p95 improved from 0.95 ms to 0.13 ms; bursts now ingest once per session/batch | Retained |
| 2026-07-25 | Phase 3 | `1a4fe416`, `16332457`, `b7fe8b3a`, `20d10513` | Stable context/callback/group identities and one cached assistant index prevent historical consumers from repeating unchanged work. | Web typecheck; 33 focused identity/component tests; production build; isolated deployment smoke test; production-data benchmark | Passed; unchanged tool groups now preserve object identity and assistant fork lookup falls from per-message linear scans to one cached linear pass | Retained |
| 2026-07-25 | Phase 4 | `268cafd6`, `64cd2c44`, `a92a1aab`, `c98c3633` | Reusing normalization, removing reducer allocations, and bounding deferred rich rendering lower pipeline work without a risky reducer rewrite. | Web typecheck; 64 focused reducer/tool/render tests; production build; isolated deployment smoke test; production-data benchmark | Passed; incremental reducer deferred because the real-data 2,400-message full reducer remains approximately 5 ms p95 and does not justify semantic risk yet | Retained |
| 2026-07-25 | Phase 5 | `3418e0b2`, `6d589a81`, `4961460e`, `597b01de`, `3947f20c` | Hysteresis, logarithmic anchor lookup, centralized mutation compensation, and render acknowledgment stabilize scroll ownership and jumps. | Web typecheck; 11 focused scroll/tool tests; production build; isolated deployment smoke test | Passed; retained the existing unified thread controller instead of replacing it wholesale, and routed tool-group height changes through that controller | Retained |
| 2026-07-25 | Phase 6 | `b89bca0d`, `3f87c633` | Paging very large expanded tool groups bounds their mounted row cost without introducing variable-height chat virtualization. | Production-data decision benchmark; Web typecheck; 8 component tests; production build; isolated deployment smoke test | Passed; real 2,400-message sample had a 94-row group, now mounted in 30-row pages; full chat virtualization deferred because only 57 visible blocks were produced | Retained |
| 2026-07-25 | Phase 7 | `8a65ff27`, `f0781f59`, `6ff1f542`, `7e3926b6`, `2c25684b`, `de5cf52d`, `ac55292c`, `218102b1` | Lean pagination, lightweight history, compression, batched SSE, and removal of redundant reads reduce Hub event-loop, payload, and query work. | Full typecheck; all 47 Hub tests; focused Web batching tests; production build; isolated deployment and public-tunnel smoke tests | Passed; user history collapses up to 2,000 client requests into one lightweight request, pagination drops probe queries, and Hub/Web both batch burst messages | Retained |

## Final Report Checklist

- Baseline and best measurements.
- Retained commits and their measured effects.
- Reverted attempts and reasons.
- Correctness and scroll regression results.
- Validation deployment details without secrets.
- Remaining risks and deferred architectural work.
