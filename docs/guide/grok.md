# Grok Build

HAPI supports [Grok Build](https://grok.com) as a coding agent, with remote control via the web app and phone.

## Prerequisites

Install and authenticate the Grok Build CLI (`grok` on PATH):

```bash
grok --version
grok login          # browser OAuth
# or for headless/CI:
export XAI_API_KEY=xai-...
```

## Usage

```bash
# Local TUI (interactive Grok in the terminal, still registered with the hub)
hapi grok

# Remote mode (web/phone controlled via ACP: `grok agent stdio`)
hapi grok --hapi-starting-mode remote

# Model + auto-approve tools
hapi grok --model grok-4.5 --yolo

# Resume an existing Grok session
hapi grok --resume <session-id>
```

From the web UI: **New Session → Grok**, optionally pick a model and enable YOLO.

## How it works

| Mode | Mechanism |
|------|-----------|
| **Local** | Spawns interactive `grok` TUI in the working directory |
| **Remote** | Spawns `grok agent stdio` (ACP), streams text/tools/permissions through the hub |

Session resume IDs are stored as `metadata.grokSessionId`.

## Permission modes

| Mode | Behavior |
|------|----------|
| `default` | Prompt for tool approval in the web UI |
| `acceptEdits` | Auto-approve edit/write tools |
| `plan` | Plan mode (`--permission-mode plan`) |
| `bypassPermissions` | Full auto-approve (`--always-approve` on ACP / YOLO toggle) |

## Models

Default: `grok-4.5`. Override with `--model`, `GROK_MODEL`, or the New Session model picker.

## Notes

- Requires a logged-in Grok account (`~/.grok/auth.json`) or `XAI_API_KEY`.
- Remote sessions use the same ACP transport as Gemini/OpenCode (`AcpSdkBackend`), plus Grok’s post-initialize `authenticate` step.
