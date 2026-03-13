#!/usr/bin/env bash
set -euo pipefail

# Safety net: catch ANY unhandled error so the script never exits silently.
# On bash 3.2 (macOS), set -e + $() subshells can kill the script without
# printing anything. This trap ensures the user always sees an error message.
trap 'echo -e "\n\033[0;31m[ERROR]\033[0m Script failed unexpectedly (line ${LINENO:-?}). This is a bug — please report it." >&2' ERR

REPO="kvinwang/hapi"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="hapi"
HUB_BINARY_NAME="hapi-hub"
RUNNER_BINARY_NAME="hapi-runner"
HAPPIER_BINARY_NAME="happier"

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
# Returns: os-arch (e.g. linux-x64, linux-armv7, linux-mips)
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
        x86_64|amd64)   arch="x64" ;;
        aarch64|arm64)  arch="arm64" ;;
        i686|i386)      arch="i686" ;;
        armv7*|armv8l)  arch="armv7" ;;
        armv6*|armv5*|arm) arch="arm" ;;
        mips)           arch="mips" ;;
        mipsel|mips64el) arch="mipsel" ;;
        ppc|powerpc)    arch="ppc" ;;
        *)              error "Unsupported architecture: $arch" ;;
    esac

    echo "${os}-${arch}"
}

# --- Map platform to hapi (Bun) artifact name ---
# Returns artifact name or empty string if not available
hapi_artifact() {
    local platform="$1"
    case "$platform" in
        linux-x64)    echo "hapi-linux-x64.tar.gz" ;;
        linux-arm64)  echo "hapi-linux-arm64.tar.gz" ;;
        darwin-x64)   echo "hapi-darwin-x64.tar.gz" ;;
        darwin-arm64) echo "hapi-darwin-arm64.tar.gz" ;;
        *)            echo "" ;;
    esac
}

# --- Map platform to happier (Rust) artifact name ---
# Returns artifact name or empty string if not available
happier_artifact() {
    local platform="$1"
    case "$platform" in
        linux-x64)    echo "happier-x86_64-unknown-linux-musl.tar.gz" ;;
        linux-i686)   echo "happier-i686-unknown-linux-musl.tar.gz" ;;
        linux-arm64)  echo "happier-aarch64-unknown-linux-musl.tar.gz" ;;
        linux-armv7)  echo "happier-armv7-unknown-linux-musleabihf.tar.gz" ;;
        linux-arm)    echo "happier-arm-unknown-linux-musleabi.tar.gz" ;;
        linux-mips)   echo "happier-mips-unknown-linux-gnu.tar.gz" ;;
        linux-mipsel) echo "happier-mipsel-unknown-linux-gnu.tar.gz" ;;
        linux-ppc)    echo "happier-powerpc-unknown-linux-gnu.tar.gz" ;;
        darwin-x64)   echo "happier-x86_64-apple-darwin.tar.gz" ;;
        darwin-arm64) echo "happier-aarch64-apple-darwin.tar.gz" ;;
        *)            echo "" ;;
    esac
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
# COMPAT: Functions called inside $() must NEVER call error() — on bash 3.2
# with set -e, exit 1 only kills the subshell, then set -e silently kills
# the main script. These functions return 1 on failure; callers handle errors.
get_latest_version() {
    local version=""

    # Method 1: GitHub redirect — no API call, no rate limit
    # /releases/latest 302-redirects to /releases/tag/<version>
    # Use -w '%{redirect_url}' to capture the first redirect target without
    # following it — avoids downloading the full HTML page.
    local redir_url
    redir_url="$(curl -s -o /dev/null -w '%{redirect_url}' \
        "https://github.com/${REPO}/releases/latest" 2>/dev/null)" || true
    if [ -n "$redir_url" ]; then
        local tag="${redir_url##*/}"
        case "$tag" in v[0-9]*|[0-9]*) version="$tag" ;; esac
    fi

    # Method 2: API fallback (includes prereleases)
    if [ -z "$version" ]; then
        local tmpfile
        tmpfile="$(mktemp)" || return 1
        curl -sSL -o "$tmpfile" \
            "https://api.github.com/repos/${REPO}/releases?per_page=1" 2>/dev/null || true
        version="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmpfile")" || true
        rm -f "$tmpfile"
    fi

    if [ -z "$version" ]; then
        return 1
    fi
    echo "$version"
}

# --- Fetch latest version (top-level wrapper with error reporting) ---
# Also called inside $(), so must use return 1 (not error/exit).
fetch_version() {
    local version="${HAPI_VERSION:-}"
    if [ -z "$version" ]; then
        echo -e "${GREEN}[INFO]${NC} Fetching latest version..." >&2
        if ! version="$(get_latest_version)"; then
            echo -e "${RED}[ERROR]${NC} Failed to fetch latest release from GitHub." >&2
            echo -e "  Check your network or visit: https://github.com/${REPO}/releases" >&2
            return 1
        fi
    fi
    echo "$version"
}

# --- Download and install a tarball ---
# Returns tmpdir path via stdout. Returns 1 on failure (caller must handle).
download_and_extract() {
    local artifact="$1" version="$2" binary_name="$3"
    local url="https://github.com/${REPO}/releases/download/${version}/${artifact}"
    local tmpdir
    tmpdir="$(mktemp -d)"

    info "Downloading ${CYAN}${artifact}${NC} (${version})..." >&2
    if ! curl -fSL --progress-bar -o "${tmpdir}/${artifact}" "$url" 2>/dev/null; then
        rm -rf "$tmpdir"
        echo "" >&2
        echo -e "${RED}[ERROR]${NC} Download failed: ${artifact} (${version})" >&2
        echo -e "  URL: ${url}" >&2
        echo -e "  Check: https://github.com/${REPO}/releases/tag/${version}" >&2
        return 1
    fi

    info "Extracting..." >&2
    tar -xzf "${tmpdir}/${artifact}" -C "$tmpdir"

    if [ ! -f "${tmpdir}/${binary_name}" ]; then
        rm -rf "$tmpdir"
        echo -e "${RED}[ERROR]${NC} Binary '${binary_name}' not found in archive" >&2
        return 1
    fi

    echo "$tmpdir"
}

# --- Install a file to INSTALL_DIR ---
install_file() {
    local src="$1" dest_name="$2"
    if [ -w "$INSTALL_DIR" ]; then
        mv "$src" "${INSTALL_DIR}/${dest_name}"
        chmod +x "${INSTALL_DIR}/${dest_name}"
    else
        sudo mv "$src" "${INSTALL_DIR}/${dest_name}"
        sudo chmod +x "${INSTALL_DIR}/${dest_name}"
    fi
}

copy_file() {
    local src="$1" dest_name="$2"
    if [ -w "$INSTALL_DIR" ]; then
        cp "$src" "${INSTALL_DIR}/${dest_name}"
        chmod +x "${INSTALL_DIR}/${dest_name}"
    else
        sudo cp "$src" "${INSTALL_DIR}/${dest_name}"
        sudo chmod +x "${INSTALL_DIR}/${dest_name}"
    fi
}

# --- Install hapi (Bun binary) ---
install_hapi() {
    local platform="$1" version="$2"
    local artifact
    artifact="$(hapi_artifact "$platform")"
    [ -z "$artifact" ] && error "No hapi binary available for ${platform}"

    local tmpdir
    if ! tmpdir="$(download_and_extract "$artifact" "$version" "hapi")"; then
        exit 1
    fi

    info "Installing hapi to ${INSTALL_DIR}..."
    install_file "${tmpdir}/hapi" "${BINARY_NAME}"

    # Create hub/runner copies
    copy_file "${INSTALL_DIR}/${BINARY_NAME}" "${HUB_BINARY_NAME}"
    copy_file "${INSTALL_DIR}/${BINARY_NAME}" "${RUNNER_BINARY_NAME}"

    rm -rf "$tmpdir"
    info "Installed ${CYAN}hapi${NC} ${version} to ${INSTALL_DIR}/${BINARY_NAME}"
}

# --- Install happier (Rust binary) ---
install_happier() {
    local platform="$1" version="$2"
    local artifact
    artifact="$(happier_artifact "$platform")"
    [ -z "$artifact" ] && error "No happier binary available for ${platform}"

    local tmpdir
    if ! tmpdir="$(download_and_extract "$artifact" "$version" "happier")"; then
        exit 1
    fi

    info "Installing happier to ${INSTALL_DIR}..."
    install_file "${tmpdir}/happier" "${HAPPIER_BINARY_NAME}"

    rm -rf "$tmpdir"
    info "Installed ${CYAN}happier${NC} ${version} to ${INSTALL_DIR}/${HAPPIER_BINARY_NAME}"
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

# --- Prompt for runner credentials ---
prompt_runner_credentials() {
    if [ -z "${HAPI_API_URL:-}" ]; then
        echo ""
        echo -e "${CYAN}Remote runner setup${NC}"
        echo -n "  Hub URL (e.g. https://hapi.example.com): "
        read -r HAPI_API_URL </dev/tty
    fi
    if [ -z "${CLI_API_TOKEN:-}" ]; then
        echo -n "  CLI API Token: "
        read -r CLI_API_TOKEN </dev/tty
    fi
    if [ -z "${HAPI_MACHINE_NAME:-}" ]; then
        local default_name
        default_name="$(hostname 2>/dev/null || echo "")"
        if [ -n "$default_name" ]; then
            echo -n "  Machine name [${default_name}]: "
        else
            echo -n "  Machine name: "
        fi
        read -r HAPI_MACHINE_NAME </dev/tty
        HAPI_MACHINE_NAME="${HAPI_MACHINE_NAME:-$default_name}"
    fi
}

# --- Check if SSH server is running ---
check_sshd() {
    local running=false
    case "$(uname -s)" in
        Darwin)
            if launchctl list 2>/dev/null | grep -q 'com.openssh.sshd'; then
                running=true
            fi
            ;;
        Linux)
            if command -v systemctl &>/dev/null && systemctl is-active --quiet sshd 2>/dev/null; then
                running=true
            elif command -v systemctl &>/dev/null && systemctl is-active --quiet ssh 2>/dev/null; then
                running=true
            elif pgrep -x sshd &>/dev/null; then
                running=true
            fi
            ;;
    esac
    if [ "$running" = false ]; then
        echo ""
        warn "SSH server is not running. Remote SSH access will not work."
        case "$(uname -s)" in
            Darwin) echo -e "  Enable with: ${CYAN}sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist${NC}" ;;
            Linux)  echo -e "  Enable with: ${CYAN}sudo systemctl enable --now sshd${NC}" ;;
        esac
        echo ""
    fi
}

# --- Setup systemd service for hapi ---
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
ExecStart=${INSTALL_DIR}/${HUB_BINARY_NAME} hub --relay
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
After=network.target

[Service]
Type=simple
Environment=PATH=${svc_path}
ExecStart=${INSTALL_DIR}/${RUNNER_BINARY_NAME} runner start --foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
        else
            prompt_runner_credentials

            cat > "$runner_service" <<EOF
[Unit]
Description=HAPI Runner
After=network.target

[Service]
Type=simple
Environment=PATH=${svc_path}
Environment=HAPI_API_URL=${HAPI_API_URL}
Environment=CLI_API_TOKEN=${CLI_API_TOKEN}
Environment=HAPI_MACHINE_NAME=${HAPI_MACHINE_NAME}
ExecStart=${INSTALL_DIR}/${RUNNER_BINARY_NAME} runner start --foreground
Restart=on-failure
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

    enable_linger
}

# --- Setup systemd service for happier ---
setup_systemd_happier() {
    local service_dir="${HOME}/.config/systemd/user"
    mkdir -p "$service_dir"

    prompt_runner_credentials

    cat > "${service_dir}/happier.service" <<EOF
[Unit]
Description=HAPI Runner (happier)
After=network.target

[Service]
Type=simple
Environment=HAPI_API_URL=${HAPI_API_URL}
Environment=CLI_API_TOKEN=${CLI_API_TOKEN}
Environment=HAPI_MACHINE_NAME=${HAPI_MACHINE_NAME}
ExecStart=${INSTALL_DIR}/${HAPPIER_BINARY_NAME}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    info "Created ${CYAN}happier.service${NC}"

    systemctl --user daemon-reload
    systemctl --user enable --now happier.service
    info "happier service ${GREEN}started${NC}"

    enable_linger
}

# --- Setup launchd service for happier (macOS) ---
setup_launchd_happier() {
    local plist_dir="${HOME}/Library/LaunchAgents"
    mkdir -p "$plist_dir"
    local log_dir="${HOME}/.hapi/logs"
    mkdir -p "$log_dir"

    prompt_runner_credentials

    cat > "${plist_dir}/com.hapi.happier.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.happier</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/${HAPPIER_BINARY_NAME}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HAPI_API_URL</key>
        <string>${HAPI_API_URL}</string>
        <key>CLI_API_TOKEN</key>
        <string>${CLI_API_TOKEN}</string>
        <key>HAPI_MACHINE_NAME</key>
        <string>${HAPI_MACHINE_NAME}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${log_dir}/happier.log</string>
    <key>StandardErrorPath</key>
    <string>${log_dir}/happier.log</string>
</dict>
</plist>
EOF
    launchctl load "${plist_dir}/com.hapi.happier.plist" 2>/dev/null || true
    info "happier launchd agent ${GREEN}started${NC}"
}

# --- Setup happier service (auto-detect OS) ---
setup_happier_service() {
    local os
    os="$(uname -s)"
    if [ "$os" = "Linux" ]; then
        setup_systemd_happier
    elif [ "$os" = "Darwin" ]; then
        setup_launchd_happier
    fi
}

# --- Enable linger for user services ---
enable_linger() {
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
            prompt_runner_credentials
            extra_env_keys="        <key>HAPI_API_URL</key>
        <string>${HAPI_API_URL}</string>
        <key>CLI_API_TOKEN</key>
        <string>${CLI_API_TOKEN}</string>
        <key>HAPI_MACHINE_NAME</key>
        <string>${HAPI_MACHINE_NAME}</string>"
        fi

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

# --- Run happier directly (download to tmp, prompt credentials, exec) ---
run_happier() {
    echo ""
    echo -e "${CYAN}  HAPI — Run happier${NC}"
    echo ""

    check_deps
    local platform
    platform="$(detect_platform)"
    info "Platform: ${CYAN}${platform}${NC}"

    local artifact
    artifact="$(happier_artifact "$platform")"
    [ -z "$artifact" ] && error "No happier binary available for ${platform}"

    local version
    if ! version="$(fetch_version)"; then
        exit 1
    fi

    local tmpdir
    if ! tmpdir="$(download_and_extract "$artifact" "$version" "happier")"; then
        exit 1
    fi
    chmod +x "${tmpdir}/happier"

    prompt_runner_credentials
    check_sshd

    info "Starting happier (Ctrl+C to stop)..."
    echo ""
    export HAPI_API_URL CLI_API_TOKEN HAPI_MACHINE_NAME
    exec "${tmpdir}/happier"
}

# --- Detect existing installation ---
# Sets: installed_hapi, installed_happier (path or empty)
detect_installed() {
    installed_hapi=""
    installed_happier=""
    if [ -x "${INSTALL_DIR}/${BINARY_NAME}" ]; then
        installed_hapi="${INSTALL_DIR}/${BINARY_NAME}"
    fi
    if [ -x "${INSTALL_DIR}/${HAPPIER_BINARY_NAME}" ]; then
        installed_happier="${INSTALL_DIR}/${HAPPIER_BINARY_NAME}"
    fi
}

# --- Reconfigure service (no download) ---
reconfigure_service() {
    local what="$1"  # "hapi", "happier", or "both"
    local os
    os="$(uname -s)"

    if [ "$what" = "happier" ]; then
        if [ "$os" = "Linux" ]; then
            setup_systemd_happier
        elif [ "$os" = "Darwin" ]; then
            setup_launchd_happier
        fi
    elif [ "$what" = "hapi" ]; then
        echo ""
        echo -e "${CYAN}Choose deployment mode for hapi:${NC}"
        echo "  1) Hub + Runner  (full setup on this machine)"
        echo "  2) Runner only   (connect to a remote hub)"
        echo "  3) Hub only"
        echo ""
        local mode_choice
        read -rp "Select [1-3] (default: 2): " mode_choice </dev/tty

        local mode
        case "${mode_choice:-2}" in
            1) mode="both" ;;
            2) mode="runner" ;;
            3) mode="hub" ;;
            *) mode="runner" ;;
        esac

        if [ "$os" = "Linux" ]; then
            setup_systemd "$mode"
        elif [ "$os" = "Darwin" ]; then
            setup_launchd "$mode"
        fi
    fi

    echo ""
    info "${GREEN}Reconfiguration complete!${NC}"
}

# --- Main ---
main() {
    # Handle --run flag: download and run happier without installing
    if [ "${1:-}" = "--run" ] || [ "${1:-}" = "run" ]; then
        run_happier
        return
    fi

    echo ""
    echo -e "${CYAN}  HAPI Installer${NC}"
    echo ""

    check_deps
    local platform
    platform="$(detect_platform)"
    info "Platform: ${CYAN}${platform}${NC}"

    # Version
    local version
    if ! version="$(fetch_version)"; then
        exit 1
    fi

    local has_hapi has_happier
    has_hapi="$(hapi_artifact "$platform")"
    has_happier="$(happier_artifact "$platform")"

    if [ -z "$has_hapi" ] && [ -z "$has_happier" ]; then
        error "No binary available for ${platform}.\n  Supported platforms: linux-x64, linux-arm64, linux-i686, linux-armv7, linux-arm, linux-mips, linux-mipsel, linux-ppc, darwin-x64, darwin-arm64"
    fi

    # --- Detect existing installation ---
    detect_installed

    # --- Platform without hapi: install happier directly ---
    if [ -z "$has_hapi" ]; then
        if [ -n "$installed_happier" ]; then
            echo ""
            echo -e "${CYAN}happier is already installed:${NC} ${installed_happier}"
            echo ""
            echo "  1) Update         (download ${version} and reinstall)"
            echo "  2) Reconfigure    (change service settings)"
            echo "  3) Cancel"
            echo ""
            read -rp "Select [1-3] (default: 1): " choice </dev/tty
            case "${choice:-1}" in
                2) reconfigure_service "happier"; return ;;
                3) info "Cancelled."; return ;;
            esac
        fi
        info "Installing ${CYAN}happier${NC} (lightweight runner)..."
        install_happier "$platform" "$version"

        echo ""
        echo -e "${CYAN}What would you like to do?${NC}"
        echo "  1) Set up as a service (auto-start on boot)"
        echo "  2) Run now in foreground (no service)"
        echo "  3) Skip  (just install the binary)"
        echo ""
        read -rp "Select [1-3] (default: 1): " choice </dev/tty

        case "${choice:-1}" in
            1) setup_happier_service ;;
            2)
                prompt_runner_credentials
                info "Starting happier (Ctrl+C to stop)..."
                echo ""
                export HAPI_API_URL CLI_API_TOKEN HAPI_MACHINE_NAME
                exec "${INSTALL_DIR}/${HAPPIER_BINARY_NAME}"
                ;;
        esac

        echo ""
        info "${GREEN}Installation complete!${NC}"
        echo ""
        echo "  happier connects to a remote hub as a lightweight runner."
        echo "  Configure with environment variables:"
        echo "    HAPI_API_URL=https://hapi.example.com"
        echo "    CLI_API_TOKEN=your-token"
        echo "    ${INSTALL_DIR}/${HAPPIER_BINARY_NAME}"
        echo ""
        return
    fi

    # --- Platform with hapi available ---
    echo ""
    echo -e "${CYAN}Choose what to install:${NC}"
    local hapi_hint="" happier_hint=""
    [ -n "$installed_hapi" ] && hapi_hint=" ${YELLOW}[installed]${NC}"
    [ -n "$installed_happier" ] && happier_hint=" ${YELLOW}[installed]${NC}"
    echo -e "  1) hapi       (full CLI — hub, runner, sessions)${hapi_hint}"
    if [ -n "$has_happier" ]; then
        echo -e "  2) happier    (lightweight runner only — tunnels, SSH keys)${happier_hint}"
        echo "  3) both"
        echo "  4) Reconfigure existing service"
    fi
    echo ""
    local install_choice
    read -rp "Select [1${has_happier:+-4}] (default: 1): " install_choice </dev/tty

    # Handle reconfigure
    if [ "${install_choice}" = "4" ] && [ -n "$has_happier" ]; then
        if [ -n "$installed_hapi" ] && [ -n "$installed_happier" ]; then
            echo ""
            echo -e "${CYAN}Reconfigure which service?${NC}"
            echo "  1) hapi"
            echo "  2) happier"
            echo ""
            read -rp "Select [1-2] (default: 2): " reconf_choice </dev/tty
            case "${reconf_choice:-2}" in
                1) reconfigure_service "hapi" ;;
                *) reconfigure_service "happier" ;;
            esac
        elif [ -n "$installed_hapi" ]; then
            reconfigure_service "hapi"
        elif [ -n "$installed_happier" ]; then
            reconfigure_service "happier"
        else
            warn "Nothing installed to reconfigure."
        fi
        return
    fi

    local do_hapi="" do_happier=""
    case "${install_choice:-1}" in
        1) do_hapi="1" ;;
        2) [ -n "$has_happier" ] && do_happier="1" || do_hapi="1" ;;
        3) [ -n "$has_happier" ] && { do_hapi="1"; do_happier="1"; } || do_hapi="1" ;;
        *) do_hapi="1" ;;
    esac

    # Check if selected components are already installed
    if [ -n "$do_hapi" ] && [ -n "$installed_hapi" ] && [ -z "$do_happier" ]; then
        local hapi_ver=""
        hapi_ver="$("$installed_hapi" --version 2>/dev/null || echo "unknown")"
        echo ""
        echo -e "${CYAN}hapi is already installed:${NC} ${installed_hapi} (${hapi_ver})"
        echo ""
        echo "  1) Update         (download ${version} and reinstall)"
        echo "  2) Reconfigure    (change service settings)"
        echo "  3) Cancel"
        echo ""
        read -rp "Select [1-3] (default: 1): " choice </dev/tty
        case "${choice:-1}" in
            2) reconfigure_service "hapi"; return ;;
            3) info "Cancelled."; return ;;
        esac
    fi
    if [ -n "$do_happier" ] && [ -n "$installed_happier" ] && [ -z "$do_hapi" ]; then
        echo ""
        echo -e "${CYAN}happier is already installed:${NC} ${installed_happier}"
        echo ""
        echo "  1) Update         (download ${version} and reinstall)"
        echo "  2) Reconfigure    (change service settings)"
        echo "  3) Cancel"
        echo ""
        read -rp "Select [1-3] (default: 1): " choice </dev/tty
        case "${choice:-1}" in
            2) reconfigure_service "happier"; return ;;
            3) info "Cancelled."; return ;;
        esac
    fi

    [ -n "$do_hapi" ] && install_hapi "$platform" "$version"
    [ -n "$do_happier" ] && install_happier "$platform" "$version"

    # Verify hapi
    if [ -n "$do_hapi" ]; then
        if ! "${INSTALL_DIR}/${BINARY_NAME}" --version &>/dev/null; then
            warn "hapi binary installed but failed to run. Check glibc compatibility."
        fi
        check_ai_cli
    fi

    # --- Service setup ---
    if [ -n "$do_hapi" ]; then
        echo ""
        echo -e "${CYAN}Choose deployment mode for hapi:${NC}"
        echo "  1) Hub + Runner  (full setup on this machine)"
        echo "  2) Runner only   (connect to a remote hub)"
        echo "  3) Hub only"
        echo "  4) Skip          (just install the binary)"
        echo ""
        read -rp "Select [1-4] (default: 4): " choice </dev/tty

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
    fi

    if [ -n "$do_happier" ] && [ -z "$do_hapi" ]; then
        # happier-only on a hapi-capable platform
        echo ""
        echo -e "${CYAN}What would you like to do with happier?${NC}"
        echo "  1) Set up as a service (auto-start on boot)"
        echo "  2) Run now in foreground (no service)"
        echo "  3) Skip  (just install the binary)"
        echo ""
        read -rp "Select [1-3] (default: 3): " choice </dev/tty
        case "${choice:-3}" in
            1) setup_happier_service ;;
            2)
                prompt_runner_credentials
                info "Starting happier (Ctrl+C to stop)..."
                echo ""
                export HAPI_API_URL CLI_API_TOKEN HAPI_MACHINE_NAME
                exec "${INSTALL_DIR}/${HAPPIER_BINARY_NAME}"
                ;;
        esac
    elif [ -n "$do_happier" ] && [ -n "$do_hapi" ]; then
        # Both installed — ask about happier service separately
        echo ""
        echo -e "${CYAN}Set up happier as an additional service?${NC}"
        echo "  1) Yes"
        echo "  2) No"
        echo ""
        read -rp "Select [1-2] (default: 2): " choice </dev/tty
        if [ "${choice:-2}" = "1" ]; then
            setup_happier_service
        fi
    fi

    echo ""
    info "${GREEN}Installation complete!${NC}"
    echo ""
    if [ -n "$do_hapi" ]; then
        echo "  Quick start:"
        echo "    hapi hub --relay     # Start hub with public relay"
        echo "    hapi runner start    # Start background runner"
        echo "    hapi                 # Start a coding session"
        echo ""
    fi
    if [ -n "$do_happier" ]; then
        echo "  Happier (lightweight runner):"
        echo "    HAPI_API_URL=... CLI_API_TOKEN=... happier"
        echo ""
    fi
}

main "$@"
