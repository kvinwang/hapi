# hapi CLI

Run Claude Code, Codex, Cursor Agent, Gemini, Grok Build, OpenCode, or Pi sessions from your terminal and control them remotely through the hapi hub.

## What it does

- Starts Claude Code sessions and registers them with hapi-hub.
- Starts Codex mode for OpenAI-based sessions.
- Starts Cursor Agent mode for Cursor CLI sessions.
- Starts Gemini mode via ACP (Anthropic Code Plugins).
- Starts Grok Build mode via ACP (`grok agent stdio`).
- Starts OpenCode mode via ACP and its plugin hook system.
- Provides an MCP stdio bridge for external tools.
- Manages a background runner for long-running sessions.
- Includes diagnostics and auth helpers.

## Typical flow

1. Start the hub and set env vars (see ../hub/README.md).
2. Set the same CLI_API_TOKEN on this machine or run `hapi auth login`.
3. Run `hapi` to start a session.
4. Use the web app or Telegram Mini App to monitor and control.

## Commands

### Session commands

- `hapi` - Start a Claude Code session (passes through Claude CLI flags). See `src/index.ts`.
- `hapi codex` - Start Codex mode. See `src/codex/runCodex.ts`.
- `hapi codex resume <sessionId>` - Resume existing Codex session.
- `hapi cursor` - Start Cursor Agent mode. See `src/cursor/runCursor.ts`.
  Supports `hapi cursor resume <chatId>`, `hapi cursor --continue`, `--mode plan|ask`, `--yolo`, `--model`.
  Local and remote modes supported; remote uses `agent -p` with stream-json.
- `hapi gemini` - Start Gemini mode via ACP. See `src/agent/runners/runAgentSession.ts`.
  Note: Gemini runs in remote mode only; it waits for messages from the hub UI/Telegram.
- `hapi grok` - Start Grok Build mode via ACP. See `src/grok/runGrok.ts`.
  Supports local TUI and remote ACP (`grok agent stdio`), `--model`, `--resume`, `--yolo` (maps to `bypassPermissions`).
- `hapi opencode` - Start OpenCode mode via ACP. See `src/opencode/runOpencode.ts`.
  Note: OpenCode supports local and remote modes; local mode streams via OpenCode plugins.
- `hapi pi` - Start Pi in RPC-backed remote mode. Supports `--model provider/model`,
  `--effort`, `--resume`, and HAPI-managed tool approvals. Universal model-provider
  credentials and compatible Codex API-key credentials can be selected per session
  without modifying the machine's Pi configuration.
- `hapi upload [--session <id>] [--name <filename>] <path>` - Upload a local file and print its share URL.

### Authentication

- `hapi auth status` - Show authentication configuration and token source.
- `hapi auth login` - Interactively enter and save CLI_API_TOKEN.
- `hapi auth logout` - Clear saved credentials.

See `src/commands/auth.ts`.

### Runner management

- `hapi runner start` - Start runner as detached process.
- `hapi runner stop` - Stop runner gracefully.
- `hapi runner status` - Show runner diagnostics.
- `hapi runner list` - List active sessions managed by runner.
- `hapi runner stop-session <sessionId>` - Terminate specific session.
- `hapi runner logs` - Print path to latest runner log file.

See `src/runner/run.ts`.

### Diagnostics

- `hapi doctor` - Show full diagnostics (version, runner status, logs, processes).
- `hapi doctor clean` - Kill runaway HAPI processes.

See `src/ui/doctor.ts`.

### Other

- `hapi mcp` - Start MCP stdio bridge. See `src/codex/happyMcpStdioBridge.ts`.
- `hapi hub` - Start the bundled hub (single binary workflow).
- `hapi server` - Alias for `hapi hub`.
- `hapi session set-title [--session <id>] <title>` - Rename a session using `HAPI_SESSION_ID` by default.
- `hapi session export [--session <id>] [-o <file>]` - Export full session JSON (same shape as shared `?fmt=json`).

## Configuration

See `src/configuration.ts` for all options.

### Required

- `CLI_API_TOKEN` - Shared secret; must match the hub. Can be set via env or `~/.hapi/settings.json` (env wins).
- `HAPI_API_URL` - Hub base URL (default: http://localhost:3006).

### Optional

- `HAPI_HOME` - Config/data directory (default: ~/.hapi).
- `HAPI_EXPERIMENTAL` - Enable experimental features (true/1/yes).
- `HAPI_EXTRA_HEADERS_JSON` - JSON object of extra headers to send on CLI → hub requests, e.g. `{"Cookie":"CF_Authorization=..."}`.
- `HAPI_CLAUDE_PATH` - Path to a specific `claude` executable.
- `HAPI_HTTP_MCP_URL` - Default MCP target for `hapi mcp`.

### Runner

- `HAPI_RUNNER_HEARTBEAT_INTERVAL` - Heartbeat interval in ms (default: 60000).
- `HAPI_RUNNER_HTTP_TIMEOUT` - HTTP timeout for runner control in ms (default: 10000).

### Worktree (set by runner)

- `HAPI_WORKTREE_BASE_PATH` - Base repository path.
- `HAPI_WORKTREE_BRANCH` - Current branch name.
- `HAPI_WORKTREE_NAME` - Worktree name.
- `HAPI_WORKTREE_PATH` - Full worktree path.
- `HAPI_WORKTREE_CREATED_AT` - Creation timestamp (ms).

## Storage

Data is stored in `~/.hapi/` (or `$HAPI_HOME`):

- `settings.json` - User settings (machineId, token, onboarding flag). See `src/persistence.ts`.
- `runner.state.json` - Runner state (pid, port, version, heartbeat).
- `logs/` - Log files.

## Requirements

- Claude CLI installed and logged in (`claude` on PATH).
- Cursor Agent CLI installed (`agent` on PATH) for `hapi cursor`. Install: `curl https://cursor.com/install -fsS | bash` (macOS/Linux), `irm 'https://cursor.com/install?win32=true' | iex` (Windows).
- Grok Build CLI installed (`grok` on PATH) for `hapi grok`. Authenticate via `grok login` or `XAI_API_KEY`.
- OpenCode CLI installed (`opencode` on PATH).
- Pi CLI 0.86.1 or newer installed (`pi` on PATH).
- Bun for building from source.

## Build from source

From the repo root:

```bash
bun install
bun run build:cli
bun run build:cli:exe
```

For an all-in-one binary that also embeds the web app:

```bash
bun run build:single-exe
```

## Source structure

- `src/api/` - Bot communication (Socket.IO + REST).
- `src/claude/` - Claude Code integration.
- `src/codex/` - Codex mode integration.
- `src/cursor/` - Cursor Agent integration.
- `src/agent/` - Multi-agent support (Gemini via ACP).
- `src/grok/` - Grok Build ACP integration.
- `src/opencode/` - OpenCode ACP + hook integration.
- `src/runner/` - Background service.
- `src/commands/` - CLI command handlers.
- `src/ui/` - User interface and diagnostics.
- `src/modules/` - Tool implementations (ripgrep, difftastic, git).

## Model discovery

The runner probes Claude Code and Codex in the background at startup and every six
hours. Codex discovery uses the app-server `model/list` API, follows pagination,
and excludes hidden models. It does not start a thread or send an inference request.
Successful Codex results are cached in `codex-models.json` under the HAPI home
directory and included in machine metadata for the new-session picker.

Remote Codex sessions also publish the catalog from their own app-server. The
in-session picker prefers this live catalog, then the machine catalog, then the
static fallback if discovery is unavailable. Custom current model values remain
selectable. Discovery failures do not block sessions or erase the last good cache.

The Codex effort picker uses each model's `supportedReasoningEfforts`, with the
live session catalog taking priority over machine metadata. Selecting another
model changes the candidate list only; it does not rewrite the selected effort.
`Default` remains available, and reported effort IDs are passed through unchanged
(including `xhigh`, `max`, and newly introduced levels). When capabilities are
unavailable, the picker retains its static fallback.

## Related docs

- `../hub/README.md`
- `../web/README.md`

## Session-scoped Codex providers

Start a native profile with `hapi codex --profile redpill` (also `-p redpill`).
HAPI loads `$CODEX_HOME/redpill.config.toml` (default `~/.codex/`) and retains the
selection when switching between local TUI and remote control. Local launches
use native `--profile`; app-server launches stay profile-free, with the profile
passed as a configuration overlay to `thread/start` and `thread/resume`.
Codex 0.155.1 rejects `--profile` on the app-server command itself. HAPI-managed
permission modes, instructions, and the RPC MCP bridge retain their normal
precedence over profile values in remote mode.

In the web composer's **Provider / Model** settings, administrators can select
machine-local profiles or existing Codex Agent Credentials in their namespace.
The picker receives only references, names, and configured model IDs, not file
contents or authentication data. Custom model IDs can also be entered. For
profile overlays, the configured model is offered instead of incorrectly using
the default app-server's process-wide model catalog.

Switching requires an active, idle, remote Codex app-server session. HAPI restarts
only that subprocess and resumes the same thread with the chosen overlay; loaded
threads otherwise ignore new resume configuration. Startup/resume failures roll
back to the previous selection. Messages arriving during the switch are held
until it completes. Legacy MCP-server mode does not support profiles.

Native profiles retain their existing authentication helpers; source files are
never modified. Profiles with command, environment-key, or inline authentication
use a private home to prevent RPC overlays from inheriting conflicting global
provider authentication fields. Helper file references remain unchanged. Database credentials retain the existing `auth` JSON plus full
TOML `config` format. Global credential import and Apply are unchanged.

For temporary database selections, HAPI combines both inputs into one private
`config.toml`: `auth.OPENAI_API_KEY` becomes the selected provider's
`experimental_bearer_token`; conflicting `auth` and `env_key` settings are removed
and `requires_openai_auth` is disabled in the temporary copy only. An explicit
provider definition and nonempty API key are required; OAuth-only credentials
are rejected without falling back to global authentication.

The private home has mode 0700 and its configuration mode 0600. No auth.json is
copied. Transcript directories remain shared for resume; the global keyring and
ambient authentication/routing overrides are not used. The key is never placed
in command-line arguments or session metadata. Normal cleanup removes the file;
an uncatchable kill can leave the private directory behind.

**Machine default / Auto** removes the overlay and restores machine defaults.
Selections last for the current HAPI CLI process. A fresh process or revive uses
machine defaults unless explicitly started with `--profile`. Private provider homes
are cleaned up on normal exit/handled termination. Saving a Codex Agent Credential
retains the whole config rather than only routing keys.
