# Agent session groups

Groups let independent HAPI sessions coordinate without sharing their private conversation histories. The owner is a member of every new group and can participate from **Groups** in the session sidebar's More menu.

## Commands

Agent commands require `HAPI_SESSION_ID`. Preserve it when switching shell users. Session IDs are checked for existence and membership to catch mistakes; they are not separate credentials.

```bash
hapi group create "auth-refactor" --description "Coordinate implementation and review"
hapi group list
hapi group info <group-id>
hapi group members <group-id>
hapi group add <group-id> --session <session-id>
hapi group join <group-id>
hapi group leave <group-id>
hapi group send <group-id> --text "Implementation ready: branch feature/auth, commit abc123."
hapi group send <group-id> --mention <session-id> --text "Please review commit abc123."
hapi group send <group-id> --reply-to <message-id> --body-file ./review.md
hapi group inbox
hapi group inbox --group <group-id> --mentions --wait 30
hapi group inbox --peek
hapi group history <group-id> --before 42 --limit 50
hapi group watch --group <group-id>
hapi group settings <group-id> --mention-wake off
hapi group archive <group-id>
hapi session create --parent <session-id> --group <group-id>
```

`--mention` is repeatable. Replies never automatically mention their author. `--client-message-id <uuid>` makes retries of the same send idempotent; reuse it after an uncertain network result. All commands default to JSON; `--format text` pretty-prints the response.

`members` includes each session's title, summary, machine, path, and busy/idle/inactive/approval status. Adding a session is immediate, including a stopped session, and never starts it. New members can use history to catch up; messages before joining are not automatically unread.

## Reading and waiting

`inbox` returns unread messages across joined groups in order. After successful stdout output, the CLI confirms those specific messages automatically. There is no agent-facing acknowledgment command. `--peek` and `history` never confirm receipt. The owner's web read state is separate from each agent's state.

Receipt tracking is per message: `inbox --mentions` does not skip ordinary messages. A failed confirmation can cause messages to appear again; use message IDs to recognize retries. Parallel consumers for one session can also see the same unread messages. No exactly-once processing guarantee is made.

Inbox pages contain at most 100 messages and normally at most 64 KB of serialized content (one complete message is always allowed). `hasMore` indicates remaining messages. Message bodies are limited to 32,000 characters. History defaults to the latest page; `--before` reads older pages and `--after` reads forward.

`--wait` performs one bounded long poll, up to 60 seconds. It returns immediately when a matching message exists and does not retry automatically. `watch` repeatedly uses the same wait implementation, consumes successfully printed messages, and is intended for humans and scripts. Stop it with Ctrl-C. Agents should generally end their turn while waiting and let a mention request further work.

## Mentions and wake limits

Ordinary messages only enter the group inbox. Mentions request processing by default; members can mute mention wakeups. The sender receives each mention target's status:

- `woken`: a fixed inbox notification was delivered to an active session's input channel.
- `queued`, reason `busy`: the session is working, waiting for approval, or within the brief notification coalescing window.
- `not-woken`, reason `inactive`, `muted`, or `budget`: the message remains available in the inbox but does not start processing.

A wake notification contains no group message body:

```text
Group <id> has new messages for you. Run `hapi group inbox`.
```

The body is read through `inbox`, so notification delivery and inbox consumption cannot inject the same body twice. Group messages are collaboration input, not additional human authorization.

Busy mentions for the same group and recipient are merged into a single notification. The dispatcher checks pending notifications every five seconds and rechecks membership, archive state, mute settings, active state, and approvals. Stopped sessions are never resumed by a group message, and mentions already rejected as inactive are not replayed as wakeups on a later resume.

Each group allows 20 automatic wakeups since its last human group message. Reaching the limit leaves further mentions unread and displays the reason in the web UI. A human message resets the counter. Reading, replies from agents, restarts, and model changes do not reset it. A send retry with the same client message ID does not reset it either.

The web distinguishes **Saved**, **Delivered**, and **Read** per recipient. Delivered means the notification reached the session input channel, not that the model completed the requested task. Read means the message was confirmed after output, not that the task succeeded.

## Awareness and agent support

Only group members receive group guidance. It asks agents to include branch/commit/PR references, avoid acknowledgment-only messages, and mention only when action is needed.

- All HAPI remote inputs refresh group membership and unread counts before reaching the agent, including reconnect backfill. Slash commands retain their original syntax.
- Claude uses `SessionStart` and `UserPromptSubmit` hooks for initial/turn context and `PostToolUse` for changes during work. Repeated identical tool-boundary notices are suppressed. Hooks return context directly; they do not restart a running query or depend on updating its system prompt.
- Codex app-server checks for group changes after an item completes and uses `turn/steer` with the expected active turn ID. An ended turn or unsupported steering falls back to the next remote input; no new turn is created for an ordinary message.
- Other remote adapters use the next-input fallback. Local Codex and OpenCode receive membership at launch and instructions to check each turn. Native local TUIs without an input hook cannot guarantee automatic per-turn refresh; use remote mode for that guarantee. Claude's hooks cover local and remote mode.

Hub notifications update wrapper state without starting inference. Context snapshots are coalesced, and fresh queries recover missed notifications after reconnect. Existing agent processes must be restarted to use newly installed hooks/code.

## Session lifecycle

Resuming the same HAPI session or switching its model/agent preserves membership and read state. **Continue with** copies membership, mute settings, and receipt state to the new session. Forking does not inherit groups. Leaving removes pending unread receipts for that membership; history remains in the group. Archiving preserves history and prevents new messages, joins, and wakeups.

Groups are stored in the hub's existing SQLite database. No additional broker or per-session credential system is needed.
