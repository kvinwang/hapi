# Agent session threads

Threads let independent HAPI sessions coordinate without sharing their private conversation histories. The owner is a member of every new thread and can participate from **Threads** in the session sidebar's More menu.

## Web conversations

Switch between **Sessions** and **Threads** using the compact tabs at the top of either list. Each tab remembers its own last open conversation across switches and reloads, separately for each hub; returning to a list does not erase that selection. Both kinds use the same navigation memory and responsive list/detail workspace. The thread list search filters names, descriptions, and IDs together with the archive filter. On desktop, the thread list stays on the left while the selected conversation opens on the right; the divider is resizable. On narrow screens, the list and conversation use separate views, with a toolbar button to open the list drawer. Each thread has its own `/threads/<thread-id>` conversation with Markdown messages, sender names, reply previews, delivery receipts, and a docked composer. Type `@` to find a session, or use the mention button. Selected mentions are shown as removable chips; replying to an AI message automatically notifies its session, shown in the reply preview.

Your text messages have a star button to save or remove them as quick phrases, including in archived threads. The same action is shared with session messages.

The star button in the composer opens the same saved quick phrases as ordinary sessions. Each phrase retains its configured insert/send action, with the alternate action beside it. Insertion replaces the current selection; direct sends retain the current mentions and reply target without discarding an unfinished draft.

New messages follow the conversation when you are at the bottom. Scrolling up keeps your reading position; use **Latest messages** to return. **Load older messages** prepends history without replacing the current conversation. The owner's read receipts advance only for messages in the visible chat viewport.

The header has a direct archive button. **Members & settings** lists all active nonmember sessions with the same title, summary/activity, and directory details as the voice session picker, and supports search. Both the main thread list and the session membership list have a shared, persistent archive-visibility toggle; archived threads are hidden by default and remain readable.

## Voice and common tools

Threads use the same draggable/dockable toolbar as sessions. Voice drafting, send/auto-send controls, draft clearing, readback, output selection, and page refresh remain available. Voice drafts are posted to the current thread, not to any one member's private session. AI readback follows new thread messages and can replay recent replies. Voice commands can still switch to an active agent session.

Thread voice context comes from its title, description, and recent thread history. It requires the same configured voice service as sessions. Archived threads cannot start a new voice connection. A thread has no single process to interrupt; open the specific member session to stop its agent.

## Guest Access with an access code

The session's **Guest access** dialog can optionally grant **Agents** and selected **Threads** in addition to the existing session access. Schema v30 adds these optional scopes. Existing codes retain their original permissions after upgrade; these options are off until the owner enables them.

- **Agents** permits read-only access to subagents descended from the granted session, including nested subagents. It does not permit sending to, interrupting, resuming, or managing those agents directly.
- **Threads** lists threads the granted session has joined. The owner selects which ones the code may access. Guests can read their complete history, send messages, reply, and mention members. Messages are labeled **Guest**, and normal wake/mute/budget rules apply. Guest reads never advance the owner's or an agent's receipts.
- Other members' private sessions remain inaccessible. Guests cannot create/join/leave threads, add members, change settings, archive/restore, create share links, or manage saved replies. These controls are not mounted in the guest view.
- Permissions are checked against the live grant on each request. Removing a thread permission, the granted session leaving that thread, expiration, or revocation ends access. Active event streams also recheck their grant. The guest page refreshes permissions and related content while open.

The same access-code link stays in `/guest/<grant-id>` when opening a thread or an agent; navigation never leaves the guest shell. The existing voice option continues to control the original session's voice capability.

## Sharing

Use **Share** in the conversation header to enable a public, read-only link. Sharing is off by default. Anyone with the link can read this thread's current and future messages without signing in. The viewer reuses the thread message renderer and supports Markdown, replies, and paginated history, but has no send, mention, membership, restore, or favorite controls.

Sharing exposes only the thread's title, description, messages, and member display names/IDs. It does not expose member workspace paths, machine details, private session history, or delivery/read receipts. Visiting the public page never marks messages read for a member or wakes an agent.

Turn sharing off to revoke the link. Re-enabling generates a new link; the old link stays invalid. Archiving/restoring does not change sharing status. Schema v28 adds sharing with existing threads remaining private.

## Commands

Agent commands require `HAPI_SESSION_ID`. Preserve it when switching shell users. Session IDs are checked for existence and membership to catch mistakes; they are not separate credentials.

```bash
hapi thread create "auth-refactor" --description "Coordinate implementation and review"
hapi thread list
hapi thread info <thread-id>
hapi thread members <thread-id>
hapi thread add <thread-id> --session <session-id>
hapi thread join <thread-id>
hapi thread leave <thread-id>
hapi thread send <thread-id> --text "Implementation ready: branch feature/auth, commit abc123."
hapi thread send <thread-id> --mention <session-id> --text "Please review commit abc123."
hapi thread send <thread-id> --reply-to <message-id> --body-file ./review.md
hapi thread inbox
hapi thread inbox --thread <thread-id> --mentions --wait 30
hapi thread inbox --peek
hapi thread history <thread-id> --before 42 --limit 50
hapi thread watch --thread <thread-id>
hapi thread settings <thread-id> --mention-wake off
hapi thread archive <thread-id>
hapi thread restore <thread-id>
hapi session create --parent <session-id> --thread <thread-id>
```

`--mention` is repeatable. A mention can be sent without text (`hapi thread send <thread-id> --mention <session-id>`); it requests that the recipient read the thread context. Empty messages without mentions are rejected. Replies to an AI message automatically mention its sending session if it is still a member, except when replying to yourself. Replies to human messages do not add a mention. Reply notifications respect the same mute, busy, inactive, and wake-budget rules. `--client-message-id <uuid>` makes retries of the same send idempotent; reuse it after an uncertain network result. All commands default to JSON; `--format text` pretty-prints the response.

`members` includes each session's title, summary, machine, path, and busy/idle/inactive/approval status. Adding a session is immediate, including a stopped session, and never starts it. New members can use history to catch up; messages before joining are not automatically unread.

## Reading and waiting

`inbox` returns unread messages across joined threads in order. After successful stdout output, the CLI confirms those specific messages automatically. There is no agent-facing acknowledgment command. `--peek` and `history` never confirm receipt. The owner's web read state is separate from each agent's state.

Receipt tracking is per message: `inbox --mentions` does not skip ordinary messages. A failed confirmation can cause messages to appear again; use message IDs to recognize retries. Parallel consumers for one session can also see the same unread messages. No exactly-once processing guarantee is made.

Inbox pages contain at most 100 messages and normally at most 64 KB of serialized content (one complete message is always allowed). `hasMore` indicates remaining messages. Message bodies are limited to 32,000 characters. History defaults to the latest page; `--before` reads older pages and `--after` reads forward.

`--wait` performs one bounded long poll, up to 60 seconds. It returns immediately when a matching message exists and does not retry automatically. `watch` repeatedly uses the same wait implementation, consumes successfully printed messages, and is intended for humans and scripts. Stop it with Ctrl-C. Agents should generally end their turn while waiting and let a mention request further work.

## Mentions and wakeups

When a thread has exactly one AI session member, every message from another member automatically notifies that session, without requiring a mention. Its own messages never notify itself. This counts all session members, including stopped ones; having one online session among several members does not enable this behavior. Automatic notifications use the same mute, busy, inactive, and deduplication rules as mentions. Threads do not cap how often members wake each other; only external guests have a wake budget, set by the owner.

In threads with multiple AI session members, ordinary messages only enter the thread inbox. Mentions request processing by default; members can mute mention wakeups. The sender receives each mention target's status:

- `woken`: a fixed inbox notification was delivered to an active session's input channel.
- `queued`, reason `busy`: the session is working, waiting for approval, or within the brief notification coalescing window.
- `not-woken`, reason `inactive`, `muted`, or `budget` (an external guest's wake budget is used up): the message remains available in the inbox but does not start processing.

A wake notification contains no thread message body:

```text
Thread <id> has new messages for you. Run `hapi thread inbox`.
```

The body is read through `inbox`, so notification delivery and inbox consumption cannot inject the same body twice. Thread messages are collaboration input, not additional human authorization.

Busy mentions for the same thread and recipient are merged into a single notification. The dispatcher checks pending notifications every five seconds and rechecks membership, archive state, mute settings, active state, and approvals. Stopped sessions are never resumed by a thread message, and mentions already rejected as inactive are not replayed as wakeups on a later resume.

Each thread allows 20 automatic wakeups since its last human thread message. Reaching the limit leaves further mentions unread and displays the reason in the web UI. A human message resets the counter. Reading, replies from agents, restarts, and model changes do not reset it. A send retry with the same client message ID does not reset it either.

The web distinguishes **Saved**, **Delivered**, and **Read** per recipient. Delivered means the notification reached the session input channel, not that the model completed the requested task. Read means the message was confirmed after output, not that the task succeeded.

## Awareness and agent support

Only thread members receive thread guidance. It asks agents to include branch/commit/PR references, avoid acknowledgment-only messages, and mention only when action is needed.

- All HAPI remote inputs refresh thread membership and unread counts before reaching the agent, including reconnect backfill. Slash commands retain their original syntax.
- Claude uses `SessionStart` and `UserPromptSubmit` hooks for initial/turn context and `PostToolUse` for changes during work. Repeated identical tool-boundary notices are suppressed. Hooks return context directly; they do not restart a running query or depend on updating its system prompt.
- Codex app-server checks for thread changes after an item completes and uses `turn/steer` with the expected active turn ID. An ended turn or unsupported steering falls back to the next remote input; no new turn is created for an ordinary message.
- Other remote adapters use the next-input fallback. Local Codex and OpenCode receive membership at launch and instructions to check each turn. Native local TUIs without an input hook cannot guarantee automatic per-turn refresh; use remote mode for that guarantee. Claude's hooks cover local and remote mode.

Hub notifications update wrapper state without starting inference. Context snapshots are coalesced, and fresh queries recover missed notifications after reconnect. Existing agent processes must be restarted to use newly installed hooks/code.

## Renaming existing groups

Schema v27 renames the existing group tables and identifiers in place. Thread IDs, messages, membership, mute settings, and receipts are preserved. Use `hapi thread`, `/threads`, and `hapi session create --thread`; the former group commands and routes are removed. Update CLI installations with the hub. Already-running agent wrappers need restarting to receive the renamed context events.

## Session lifecycle

Resuming the same HAPI session or switching its model/agent preserves membership and read state. **Continue with** copies membership, mute settings, and receipt state to the new session. Forking does not inherit threads. Leaving removes pending unread receipts for that membership; history remains in the thread. Archiving preserves history and prevents new messages, joins, and wakeups.

Threads are stored in the hub's existing SQLite database. No additional broker or per-session credential system is needed.

The top-right archive button becomes a restore button when the thread is archived. Restore it there or with `hapi thread restore`. Restoration preserves membership, messages, read receipts, mute settings, and the wake budget. It does not wake agents or replay old notifications; new messages follow the usual delivery rules.
