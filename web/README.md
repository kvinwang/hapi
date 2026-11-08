# hapi-web

React Mini App / PWA for monitoring and controlling hapi sessions.

## What it does

- Session list with status, pending approvals, todos, and summaries.
- Chat view with streaming updates and message sending.
- Permission approval and denial workflows.
- Permission mode and model selection.
- Machine list and remote session spawn.
- File browser and git status/diff views.
- PWA install prompt and offline banner.

## Runtime behavior

- When opened inside Telegram, auth uses Telegram WebApp init data.
- When opened in a normal browser, you can log in with `CLI_API_TOKEN:<namespace>` (or `CLI_API_TOKEN` for the default namespace).
- The login screen includes a top-right hub picker; if unset, the app uses the same origin it was loaded from.
- Live updates come from the hub via SSE.

## Routes

See `src/router.tsx` for route definitions.

- `/` - Redirect to /sessions.
- `/sessions` - Session list.
- `/threads` - Thread list and creation.
- `/shared/threads/$shareToken` - Public read-only thread conversation; no login required.
- `/threads/$threadId` - Thread conversation with Markdown, replies, @mentions, fixed composer, and member settings.
- `/sessions/$sessionId` - Chat interface.
- `/sessions/new` - Create new session.
- `/sessions/$sessionId/files` - File browser with git status.
- `/sessions/$sessionId/file` - File viewer with diff support.
- `/sessions/$sessionId/terminal` - Terminal interface.
- `/settings` - Application settings: category list (phone) or category nav + General (desktop).
- `/settings/{general,chat,models,devices,sessions,account,about}` - Settings groups.
- `/settings/models/providers`, `/settings/devices/{machines,add,speakers}`, `/settings/account/keys` - Managed resources.

## Features

### Session list (`src/components/SessionList.tsx`)

- Active/inactive status indicator.
- Session favorites: use the chat header menu, or long-press/right-click a session in the list.
  The Favorites only filter includes archived sessions and combines with tag search.
  Favorites persist on the hub and sync across devices, independently of pinning.
- Compact list toolbar: archive visibility, new session, and favorites are direct shortcuts;
  refresh, view mode, collapse all, shared sessions, and settings live in the More actions menu.
- Session title from name, summary, or path.
- Todo progress display.
- Pending permission request count.
- Agent flavor label (claude/codex/gemini).
- Model mode display.
- Pull-to-refresh on touch devices, refresh button on pointer devices (`src/hooks/usePullToRefresh.ts`,
  `src/components/PullToRefreshIndicator.tsx`); both share the pull/release/refreshing/updated status strip.

### Threads

- Edit thread tags from the Tags button below the conversation header.
- Tags persist on the hub and sync across devices; they remain editable on archived threads.
- Search the thread list by tag text, or use `#tag` for an exact tag match.
- Tags are private organizational metadata and are not exposed through public share links.

### Chat interface (`src/components/SessionChat.tsx`)

- Message thread with infinite scroll.
- Composer for sending messages.
- Permission mode toggle (default/acceptEdits/bypassPermissions/plan).
- Model selection: agent-discovered Claude and Codex catalogs, with static fallback.
- Codex effort candidates follow the selected model's reported capabilities; selected effort is not changed automatically.
- Session abort and mode switch controls.
- Context size display.
- A Tasks chip alongside Agents lists Claude-managed background shell tasks, including commands,
  elapsed time, lifecycle status, output tails (64 KiB, refreshed every three seconds), and per-task stop.
  The host is the agent's machine; remote processes may outlive a shell task. Missing agent/process
  connectivity is shown as unknown, not completed. Tracking requires the updated CLI and starts with
  newly observed tasks; existing historical tasks are not reconstructed from chat pages.

### File browser (`src/routes/sessions/files.tsx`)

- Git status view (staged/unstaged files).
- File search with ripgrep.
- Navigate to file viewer.

### File viewer (`src/routes/sessions/file.tsx`)

- File content display with syntax highlighting.
- Staged/unstaged diff view.

### Terminal (`src/routes/sessions/terminal.tsx`)

- Remote terminal via xterm.js
- Real-time via Socket.IO
- Resize handling

### Voice assistant

- Drafting instructions are Chinese, with readable sections for the current draft,
  the latest eight frontend conversation messages (at most 4,000 characters),
  explicit corrections, and pending fragments when present. Backend history,
  duplicate speech history, and the general session catalog are not injected.
  Session lookup fetches its candidates only when explicitly requested.

- The draft Debug button opens an unabridged snapshot of the latest sent system
  instructions, tool definitions, and all outbound text events in the current
  connection. Refresh the snapshot for subsequent updates. Audio, transport
  credentials, and server-managed conversation state are excluded. The snapshot
  stays in the browser; no extra diagnostics are logged or uploaded.

- Explicit word corrections outrank old draft and conversation spellings. Correction
  instructions edit the draft instead of becoming message prose. A session-local
  correction ledger survives draft clears; resetting voice history clears it.

- Drafts display as text by default. Drag across text repeatedly to select multiple
  ranges, then delete them together. The Edit button enables keyboard editing.
  Selecting or editing pauses microphone capture and auto-send; resume capture
  explicitly from the draft panel. Manual changes supersede pending voice edits.

- AI readback reads the currently selected HAPI conversation and favorite sessions only.
  Activating another HAPI window selects its conversation; switching to a different app
  does not discard the last selected conversation.
- Readback is serialized across same-origin tabs with Web Locks, with message-ID
  deduplication. Without Web Locks, background readers are limited to the selected tab.
- The draft header settings icon opens a compact panel for microphone sensitivity,
  readback language, output routing, and automatic/manual draft visibility.
  The toolbar draft button always opens the panel, even without recognized speech;
  manual mode keeps visibility unchanged until explicitly opened or hidden.
  Choose Chinese or English there,
  or say "以后用中文播报" / "切换成英文播报". Language and readback enablement
  persist locally and synchronize across tabs; language changes apply to subsequent items.

- ElevenLabs integration (@elevenlabs/react)
- Real-time voice control
- Read-aloud requests a neutral delivery without added emotional interjections or
  non-speech sounds. Audio outside a requested reading is ignored.
- Read-aloud prefers an identifiable, authorized speaker output. Its playback panel
  offers system output, exposed devices, and the browser device picker when available.
  The preference is remembered on the device. Routing uses `AudioContext.setSinkId`
  or an HTML audio element backed by a media-stream destination; missing APIs,
  unavailable devices, and denied permissions fall back to system output.
  The panel reports the applied output or a routing failure. Browser routing cannot
  guarantee the built-in speaker on every phone. Microphone capture stays active;
  output selection does not change the page's audio-session category.

### Voice UI commands

- The `control_ui` tool accepts one `{ command: string }` browser command, not shell code.
- `src/lib/frontendCommands.ts` defines command parsing, argument validation, and generated help in one registry.
- Examples: `draft language en`, `draft alternatives off`, `draft auto-send on 5`, `help draft`.
- Quoted arguments support spaces. Chaining, pipes, redirection, expansion, and arbitrary JavaScript are not supported.
- Voice session switching reuses the responsive session sidebar and native session cards. Top-right number badges share a frozen order with spoken selection, including child sessions; live status updates do not renumber them.
- Commands cover draft delivery/clearing/translation selection, pending speech, microphone control, readback routing, and session selection. Delivery and routing return a request acknowledgment, not a claim of completion.
- The AI prompt includes only commands marked `common` in the registry; full documentation is available through `help`. Read-only queries (`ui status`, `readback devices`) do not block later mutations. Repeated actions in an utterance are deduplicated, while distinct actions can be combined across tool calls.
- Commands dispatch to the same settings handlers as the UI. Help and validation failures do not mutate settings.

### New session (`src/components/NewSession/`)

Modular session creation:
- Machine selector
- Directory input with recent paths
- Agent type selector
- Model selector
- Permission mode toggle (YOLO mode)

## Authentication

See `src/hooks/useAuth.ts` and `src/hooks/useAuthSource.ts`.

- Telegram Mini App: Uses initData from WebApp SDK.
- Browser: Uses CLI_API_TOKEN from login prompt.
- JWT tokens with auto-refresh.

## Data fetching

See `src/hooks/queries/` for query hooks and `src/hooks/mutations/` for mutations.

- Sessions, messages, machines via TanStack Query.
- Git status and file operations.
- Optimistic updates for message sending.

## Real-time updates

See `src/hooks/useSSE.ts`.

- SSE connection to `/api/events`.
- Session/message/machine update events.
- Automatic cache invalidation on events.

## Stack

React 19 + Vite + TanStack Router/Query + Tailwind + @assistant-ui/react + xterm.js + @elevenlabs/react + socket.io-client + workbox + shiki.

## Source structure

- `src/router.tsx` - Route definitions.
- `src/components/` - UI components.
- `src/hooks/` - Data fetching and state hooks.
- `src/api/client.ts` - API client.
- `src/types/api.ts` - Type definitions.

## Development

From the repo root:

```bash
bun install
bun run dev:web
```

If testing in Telegram, set:
- `HAPI_PUBLIC_URL` to the public HTTPS URL of the dev server.
- `CORS_ORIGINS` to include the dev server origin.

## Build

```bash
bun run build:web
```

The built assets land in `web/dist` and are served by hapi-hub. The single executable can embed these assets.

## Standalone hosting

You can host `web/dist` on a static host (GitHub Pages, Cloudflare Pages) and point it at any hapi hub:

1. Build the web app. If your static host uses a subpath, set the Vite base:

```bash
bun run build:web -- --base /<repo>/
```

2. Deploy `web/dist` to your static host.
3. Set hub CORS to allow the static origin (`HAPI_PUBLIC_URL` or `CORS_ORIGINS`).
4. Open the static site, click the top-right Hub button on the login screen, and enter the hapi hub origin.

Clear the hub override in the same dialog to return to same-origin behavior.

### Codex Provider / Model picker

The composer settings and status bar show `provider / model` for Codex sessions.
Providers include machine-local Codex profiles and existing Agent Credentials;
only sanitized references, names, and model IDs are fetched for selection.
A custom model input supports providers without a discoverable model catalog. Switching providers requires administrator access
and an idle remote session. Switching failures remain visible in the picker.
The machine-default entry restores the original configuration. The override is
process-local and resets when the HAPI CLI session is restarted or revived.
