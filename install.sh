#!/usr/bin/env bash
set -euo pipefail

REPO="kvinwang/hapi"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="hapi"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Detect platform ---
detect_platform() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Linux)  os="linux" ;;
        Darwin) os="darwin" ;;
        *)      error "Unsupported OS: $os (only Linux and macOS are supported)" ;;
    esac

    case "$arch" in
        x86_64|amd64)  arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)             error "Unsupported architecture: $arch (only x64 and arm64 are supported)" ;;
    esac

    echo "${os}-${arch}"
}

# --- Check dependencies ---
check_deps() {
    local missing=()
    for cmd in curl tar; do
        if ! command -v "$cmd" &>/dev/null; then
            missing+=("$cmd")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        error "Missing required tools: ${missing[*]}\n  Install them with your package manager, e.g.:\n  sudo apt install ${missing[*]}  # Debian/Ubuntu\n  sudo yum install ${missing[*]}  # CentOS/RHEL\n  brew install ${missing[*]}      # macOS"
    fi
}

# --- Get latest version ---
get_latest_version() {
    local version
    version="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')" || true

    if [ -z "$version" ]; then
        error "Failed to fetch latest release from GitHub.\n  Check your network or visit: https://github.com/${REPO}/releases"
    fi
    echo "$version"
}

# --- Download and install ---
install_binary() {
    local platform="$1" version="$2"
    local artifact="hapi-${platform}.tar.gz"
    local url="https://github.com/${REPO}/releases/download/${version}/${artifact}"
    local tmpdir

    tmpdir="$(mktemp -d)"
    trap 'rm -rf "$tmpdir"' EXIT

    info "Downloading ${CYAN}${artifact}${NC} (${version})..."
    if ! curl -fSL --progress-bar -o "${tmpdir}/${artifact}" "$url"; then
        error "Download failed: $url\n  Check if this release exists: https://github.com/${REPO}/releases/tag/${version}"
    fi

    info "Extracting..."
    tar -xzf "${tmpdir}/${artifact}" -C "$tmpdir"

    if [ ! -f "${tmpdir}/hapi" ]; then
        error "Binary not found in archive"
    fi

    info "Installing to ${INSTALL_DIR}/${BINARY_NAME}..."
    if [ -w "$INSTALL_DIR" ]; then
        mv "${tmpdir}/hapi" "${INSTALL_DIR}/${BINARY_NAME}"
        chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    else
        sudo mv "${tmpdir}/hapi" "${INSTALL_DIR}/${BINARY_NAME}"
        sudo chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    fi
}

# --- Check AI CLI availability ---
check_ai_cli() {
    local found=()
    for cmd in claude codex gemini opencode; do
        if command -v "$cmd" &>/dev/null; then
            found+=("$cmd")
        fi
    done
    if [ ${#found[@]} -eq 0 ]; then
        warn "No AI coding CLI found. You need at least one of:"
        echo "  - Claude Code:   npm install -g @anthropic-ai/claude-code"
        echo "  - OpenAI Codex:  npm install -g @openai/codex"
        echo "  - Google Gemini: npm install -g @anthropic-ai/gemini-cli"
        echo "  - OpenCode:      go install github.com/opencode-ai/opencode@latest"
    else
        info "Found AI CLI: ${found[*]}"
    fi
}

# --- Build PATH for service environment ---
# systemd/launchd services don't inherit the user's shell PATH,
# so we need to collect directories containing AI CLIs and common tools.
build_service_path() {
    local dirs=()
    local seen=()

    add_dir() {
        local d="$1"
        # deduplicate
        for s in "${seen[@]+"${seen[@]}"}"; do
            [ "$s" = "$d" ] && return
        done
        seen+=("$d")
        dirs+=("$d")
    }

    # Always include standard system paths
    for d in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
        add_dir "$d"
    done

    # Add directories of known AI CLIs and tools
    for cmd in claude codex gemini opencode node bun npm go cargo; do
        local p
        p="$(command -v "$cmd" 2>/dev/null)" || continue
        # resolve symlinks to get the real directory
        p="$(readlink -f "$p" 2>/dev/null || echo "$p")"
        add_dir "$(dirname "$p")"
    done

    # Common user-local paths (if they exist)
    for d in \
        "${HOME}/.local/bin" \
        "${HOME}/.bun/bin" \
        "${HOME}/.cargo/bin" \
        "${HOME}/.opencode/bin" \
        "${HOME}/.nvm/versions/node"/*/bin \
        "${HOME}/.fnm/node-versions"/*/installation/bin \
        "${HOME}/.local/share/fnm/node-versions"/*/installation/bin \
    ; do
        # glob may expand to non-existent paths
        [ -d "$d" ] && add_dir "$d"
    done

    local IFS=':'
    echo "${dirs[*]}"
}

# --- Setup systemd service ---
setup_systemd() {
    local mode="$1"
    local service_dir="${HOME}/.config/systemd/user"
    mkdir -p "$service_dir"

    local svc_path
    svc_path="$(build_service_path)"
    info "Service PATH: ${svc_path}"

    if [ "$mode" = "hub" ] || [ "$mode" = "both" ]; then
        cat > "${service_dir}/hapi-hub.service" <<EOF
[Unit]
Description=HAPI Hub
After=network.target

[Service]
Type=simple
Environment=PATH=${svc_path}
ExecStart=${INSTALL_DIR}/${BINARY_NAME} hub --relay
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
        info "Created ${CYAN}hapi-hub.service${NC}"
    fi

    if [ "$mode" = "runner" ] || [ "$mode" = "both" ]; then
        local runner_service="${service_dir}/hapi-runner.service"

        if [ "$mode" = "both" ]; then
            cat > "$runner_service" <<EOF
[Unit]
Description=HAPI Runner
After=network.target hapi-hub.service
Requires=hapi-hub.service

[Service]
Type=simple
Environment=PATH=${svc_path}
ExecStart=${INSTALL_DIR}/${BINARY_NAME} runner start --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
        else
            # Runner-only mode: needs HAPI_API_URL and CLI_API_TOKEN
            if [ -z "${HAPI_API_URL:-}" ]; then
                echo ""
                echo -e "${CYAN}Remote runner setup${NC}"
                read -rp "  Hub URL (e.g. https://hapi.example.com): " HAPI_API_URL
            fi
            if [ -z "${CLI_API_TOKEN:-}" ]; then
                read -rp "  CLI API Token: " CLI_API_TOKEN
            fi

            cat > "$runner_service" <<EOF
[Unit]
Description=HAPI Runner
After=network.target

[Service]
Type=simple
Environment=PATH=${svc_path}
Environment=HAPI_API_URL=${HAPI_API_URL}
Environment=CLI_API_TOKEN=${CLI_API_TOKEN}
ExecStart=${INSTALL_DIR}/${BINARY_NAME} runner start --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
        fi
        info "Created ${CYAN}hapi-runner.service${NC}"
    fi

    systemctl --user daemon-reload

    if [ "$mode" = "hub" ] || [ "$mode" = "both" ]; then
        systemctl --user enable --now hapi-hub.service
        info "hapi-hub service ${GREEN}started${NC}"
    fi
    if [ "$mode" = "runner" ] || [ "$mode" = "both" ]; then
        systemctl --user enable --now hapi-runner.service
        info "hapi-runner service ${GREEN}started${NC}"
    fi

    # Enable linger so services survive logout
    if command -v loginctl &>/dev/null; then
        if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
            warn "User linger not enabled. Services will stop on logout."
            echo "  Run: sudo loginctl enable-linger $USER"
        fi
    fi
}

# --- Setup launchd (macOS) ---
setup_launchd() {
    local mode="$1"
    local plist_dir="${HOME}/Library/LaunchAgents"
    mkdir -p "$plist_dir"
    local log_dir="${HOME}/.hapi/logs"
    mkdir -p "$log_dir"

    local svc_path
    svc_path="$(build_service_path)"

    if [ "$mode" = "hub" ] || [ "$mode" = "both" ]; then
        cat > "${plist_dir}/com.hapi.hub.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.hub</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/${BINARY_NAME}</string>
        <string>hub</string>
        <string>--relay</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${svc_path}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${log_dir}/hub.log</string>
    <key>StandardErrorPath</key>
    <string>${log_dir}/hub.log</string>
</dict>
</plist>
EOF
        launchctl load "${plist_dir}/com.hapi.hub.plist" 2>/dev/null || true
        info "hapi-hub launchd agent ${GREEN}started${NC}"
    fi

    if [ "$mode" = "runner" ] || [ "$mode" = "both" ]; then
        local extra_env_keys=""
        if [ "$mode" = "runner" ]; then
            if [ -z "${HAPI_API_URL:-}" ]; then
                echo ""
                echo -e "${CYAN}Remote runner setup${NC}"
                read -rp "  Hub URL (e.g. https://hapi.example.com): " HAPI_API_URL
            fi
            if [ -z "${CLI_API_TOKEN:-}" ]; then
                read -rp "  CLI API Token: " CLI_API_TOKEN
            fi
            extra_env_keys="        <key>HAPI_API_URL</key>
        <string>${HAPI_API_URL}</string>
        <key>CLI_API_TOKEN</key>
        <string>${CLI_API_TOKEN}</string>"
        fi

        local svc_path
        svc_path="$(build_service_path)"

        cat > "${plist_dir}/com.hapi.runner.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.runner</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/${BINARY_NAME}</string>
        <string>runner</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${svc_path}</string>
${extra_env_keys}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${log_dir}/runner.log</string>
    <key>StandardErrorPath</key>
    <string>${log_dir}/runner.log</string>
</dict>
</plist>
EOF
        launchctl load "${plist_dir}/com.hapi.runner.plist" 2>/dev/null || true
        info "hapi-runner launchd agent ${GREEN}started${NC}"
    fi
}

# --- Main ---
main() {
    echo ""
    echo -e "${CYAN}  HAPI Installer${NC}"
    echo ""

    check_deps
    local platform
    platform="$(detect_platform)"
    info "Platform: ${CYAN}${platform}${NC}"

    # Version
    local version="${HAPI_VERSION:-}"
    if [ -z "$version" ]; then
        info "Fetching latest version..."
        version="$(get_latest_version)"
    fi

    # Install binary
    install_binary "$platform" "$version"
    info "Installed ${CYAN}hapi${NC} ${version} to ${INSTALL_DIR}/${BINARY_NAME}"

    # Verify
    if ! "${INSTALL_DIR}/${BINARY_NAME}" --version &>/dev/null; then
        warn "Binary installed but failed to run. Check glibc compatibility."
    fi

    # Check AI CLI
    check_ai_cli

    # Deployment mode
    echo ""
    echo -e "${CYAN}Choose deployment mode:${NC}"
    echo "  1) Hub + Runner  (full setup on this machine)"
    echo "  2) Runner only   (connect to a remote hub)"
    echo "  3) Hub only"
    echo "  4) Skip          (just install the binary)"
    echo ""
    read -rp "Select [1-4] (default: 4): " choice

    local mode
    case "${choice:-4}" in
        1) mode="both" ;;
        2) mode="runner" ;;
        3) mode="hub" ;;
        4) mode="" ;;
        *) mode="" ;;
    esac

    if [ -n "$mode" ]; then
        local os
        os="$(uname -s)"
        if [ "$os" = "Linux" ]; then
            setup_systemd "$mode"
        elif [ "$os" = "Darwin" ]; then
            setup_launchd "$mode"
        fi
    fi

    echo ""
    info "${GREEN}Installation complete!${NC}"
    echo ""
    echo "  Quick start:"
    echo "    hapi hub --relay     # Start hub with public relay"
    echo "    hapi runner start    # Start background runner"
    echo "    hapi                 # Start a coding session"
    echo ""
}

main "$@"
