# HAPI

Run official Claude Code / Codex / Gemini / OpenCode sessions locally and control them remotely through a Web / PWA / Telegram Mini App.

> **Why HAPI?** HAPI is a local-first alternative to Happy. See [Why Not Happy?](docs/guide/why-hapi.md) for the key differences.

## Fork notes (kvinwang/hapi)

This repo is a fork of `tiann/hapi`. Additions in this fork (high level):

- **Web UI**
    - Tree-view file browser (lazy directory loading) + state persistence  
      Browse **any file** (not just git diffs) efficiently; remembers expanded folders and selection.
    - VSCode-style workspace tabs (Chat / Files / Terminal) + persisted UI state  
      Fast switching between the three panes without losing Terminal state.
    - Inactive session **Revive**  
      One-click resume for stopped sessions (spawns a new local agent and re-attaches).
    - Sidebar: resizable; **machine → directory** nested grouping; per-group collapse + “collapse all”; quick **New Session (+)** from group  
      Keep many sessions manageable; start a session already scoped to a machine + path.
    - Mobile layout hardening (input overflow, width cap, draggable workspace tabs)  
      Usable on small screens; avoids clipped composer / hidden controls.
    - Archived sessions visibility toggle  
      Hide noise by default; still retrievable when needed.
- **CLI / Connectivity**
    - `hapi machines` (+ `hapi lsm`) for listing machines; resolve by hostname / displayName  
      Easier targeting for tunnels/ssh when you have multiple runners.
    - TCP tunnel: `hapi connect <machineId> <port>`  
      Quick port-forward to a remote machine without extra infra.
    - `hapi ssh` wrapper (tunnel ProxyCommand) + `hapi scp`  
      Use one machine’s AI to quickly operate on another machine via SSH/SCP (through the hub), even with limited networking.
- **Experimental**
    - `happier` (Rust) tunnel/runner prototype (WIP)  
      Goal: lower idle CPU/RAM than the JS runner while keeping hub protocol compatibility (currently tunnel works; other pieces TODO).

## Features

- **Seamless Handoff** - Work locally, switch to remote when needed, switch back anytime. No context loss, no session restart.
- **Native First** - HAPI wraps your AI agent instead of replacing it. Same terminal, same experience, same muscle memory.
- **AFK Without Stopping** - Step away from your desk? Approve AI requests from your phone with one tap.
- **Your AI, Your Choice** - Claude Code, Codex, Gemini, OpenCode—different models, one unified workflow.
- **Terminal Anywhere** - Run commands from your phone or browser, directly connected to the working machine.
- **Voice Control** - Talk to your AI agent hands-free using the built-in voice assistant.

## Demo

https://github.com/user-attachments/assets/38230353-94c6-4dbe-9c29-b2a2cc457546

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/kvinwang/hapi/main/install.sh | bash
```

See [Installation](docs/guide/installation.md) for more options (Homebrew, prebuilt binary, build from source).

## Getting Started

```bash
hapi hub --relay     # start hub with E2E encrypted relay
hapi                 # run claude code
```

`hapi server` remains supported as an alias.

The terminal will display a URL and QR code. Scan the QR code with your phone or open the URL to access.

> The relay uses WireGuard + TLS for end-to-end encryption. Your data is encrypted from your device to your machine.

For self-hosted options (Cloudflare Tunnel, Tailscale), see [Installation](docs/guide/installation.md)

## Docs

- [App](docs/guide/pwa.md)
- [How it Works](docs/guide/how-it-works.md)
- [Voice Assistant](docs/guide/voice-assistant.md)
- [Why HAPI](docs/guide/why-hapi.md)
- [FAQ](docs/guide/faq.md)

## Build from source

```bash
bun install
bun run build:single-exe
```

## Credits

HAPI means "哈皮" a Chinese transliteration of [Happy](https://github.com/slopus/happy). Great credit to the original project.
