#!/bin/bash
set -e

# ─── 3CXTools-Relay Installer ────────────────────────────────────
#
# Download and run (interactive):
#   curl -sSL https://raw.githubusercontent.com/REDiTECH-NOC/3CX-Tools-Suite/main/3cxtools-relay/install.sh -o /tmp/install-3cxtools-relay.sh && sudo bash /tmp/install-3cxtools-relay.sh
#
# Or with arguments (non-interactive / piped):
#   curl -sSL .../install.sh | sudo bash -s -- --wallboard-url https://wallboard:4200 --api-key KEY \
#     --pbx-ext 1000 --pbx-pass secret
#
# ──────────────────────────────────────────────────────────────────

# If stdin is not a terminal (piped), force non-interactive unless args are given
if [[ ! -t 0 ]] && [[ $# -eq 0 ]]; then
  echo ""
  echo "ERROR: Interactive mode requires a terminal."
  echo ""
  echo "Download the script first, then run it:"
  echo "  curl -sSL https://raw.githubusercontent.com/REDiTECH-NOC/3CX-Tools-Suite/main/3cxtools-relay/install.sh -o /tmp/install-3cxtools-relay.sh"
  echo "  sudo bash /tmp/install-3cxtools-relay.sh"
  echo ""
  echo "Or use non-interactive mode with arguments (run with --help for usage)."
  exit 1
fi

INSTALL_DIR="/opt/3cxtools-relay"
CONFIG_DIR="/etc/3cxtools-relay"
SERVICE_NAME="3cxtools-relay"
REQUIRED_NODE_MAJOR=20
REPO_URL="https://github.com/REDiTECH-NOC/3CX-Tools-Suite"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
ask()   { echo -en "${CYAN}$1${NC}"; }

# ─── Parse CLI Args (for non-interactive mode) ───────────────────

WALLBOARD_URL=""
API_KEY=""
PBX_URL="https://localhost"
PBX_EXT=""
PBX_PASS=""
POLL_INTERVAL=750
LOG_LEVEL="info"
AUTOPAGER_URL=""
AUTOPAGER_KEY=""
INTERACTIVE=true

while [[ $# -gt 0 ]]; do
  case $1 in
    --wallboard-url) WALLBOARD_URL="$2"; INTERACTIVE=false; shift 2 ;;
    --api-key)       API_KEY="$2"; shift 2 ;;
    --pbx-url)       PBX_URL="$2"; shift 2 ;;
    --pbx-ext)       PBX_EXT="$2"; shift 2 ;;
    --pbx-pass)      PBX_PASS="$2"; shift 2 ;;
    --poll-interval) POLL_INTERVAL="$2"; shift 2 ;;
    --log-level)     LOG_LEVEL="$2"; shift 2 ;;
    --autopager-url) AUTOPAGER_URL="$2"; shift 2 ;;
    --autopager-key) AUTOPAGER_KEY="$2"; shift 2 ;;
    --help|-h)
      echo ""
      echo "3CXTools-Relay Installer"
      echo ""
      echo "Usage: install.sh [OPTIONS]"
      echo ""
      echo "Run without arguments for interactive mode, or provide:"
      echo ""
      echo "Required:"
      echo "  --wallboard-url   Wallboard URL (e.g., https://wallboard.example.com:4200)"
      echo "  --api-key         Relay API key (from wallboard admin settings)"
      echo "  --pbx-url         3CX PBX URL (e.g., https://localhost)"
      echo "  --pbx-ext         3CX extension number for API access"
      echo "  --pbx-pass        3CX extension password"
      echo ""
      echo "Optional:"
      echo "  --poll-interval   PBX poll interval in ms (default: 750)"
      echo "  --log-level       Log level: debug, info, warn, error (default: info)"
      echo "  --autopager-url   Auto-Pager URL (e.g., http://docker-host:3001)"
      echo "  --autopager-key   Auto-Pager relay API key"
      echo ""
      exit 0
      ;;
    *) warn "Unknown argument: $1"; shift ;;
  esac
done

# ─── Check Root ───────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root (use sudo)"
fi

# ─── Banner ───────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}   3CXTools-Relay — Installer${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo ""

# ─── Interactive Prompts ─────────────────────────────────────────

if [[ "$INTERACTIVE" == true ]]; then
  echo -e "${BOLD}This installer will set up the 3CXTools-Relay on this PBX.${NC}"
  echo "The 3cxtools-relay monitors queue data locally and pushes it to"
  echo "your wallboard and/or auto-pager for real-time monitoring."
  echo ""
  echo -e "${BOLD}You'll need:${NC}"
  echo "  1. Wallboard URL and relay API key (from wallboard admin)"
  echo "  2. A 3CX extension number + password with admin API access"
  echo "  3. (Optional) Auto-pager URL and API key"
  echo ""

  # ── Wallboard connection ──
  echo -e "${BOLD}── Wallboard Connection ──${NC}"
  echo ""

  while [[ -z "$WALLBOARD_URL" ]]; do
    ask "Wallboard URL (e.g., https://wallboard.example.com:4200): "
    read -r WALLBOARD_URL
    if [[ -z "$WALLBOARD_URL" ]]; then
      echo -e "${RED}  Required.${NC}"
    fi
  done

  while [[ -z "$API_KEY" ]]; do
    ask "Relay API key (from wallboard admin settings): "
    read -r API_KEY
    if [[ -z "$API_KEY" ]]; then
      echo -e "${RED}  Required.${NC}"
    fi
  done

  echo ""

  # ── PBX connection ──
  echo -e "${BOLD}── 3CX PBX Connection ──${NC}"
  echo ""

  ask "PBX URL [${PBX_URL}]: "
  read -r input_pbx_url
  PBX_URL="${input_pbx_url:-$PBX_URL}"

  while [[ -z "$PBX_EXT" ]]; do
    ask "3CX extension number (admin API access): "
    read -r PBX_EXT
    if [[ -z "$PBX_EXT" ]]; then
      echo -e "${RED}  Required.${NC}"
    fi
  done

  while [[ -z "$PBX_PASS" ]]; do
    ask "3CX extension password: "
    read -rs PBX_PASS
    echo ""
    if [[ -z "$PBX_PASS" ]]; then
      echo -e "${RED}  Required.${NC}"
    fi
  done

  echo ""

  # ── Auto-Pager (optional) ──
  echo -e "${BOLD}── Auto-Pager (optional — press Enter to skip) ──${NC}"
  echo ""

  ask "Auto-Pager URL (e.g., http://10.0.1.225:3001): "
  read -r AUTOPAGER_URL

  if [[ -n "$AUTOPAGER_URL" ]]; then
    while [[ -z "$AUTOPAGER_KEY" ]]; do
      ask "Auto-Pager relay API key: "
      read -r AUTOPAGER_KEY
      if [[ -z "$AUTOPAGER_KEY" ]]; then
        echo -e "${RED}  Required when auto-pager URL is set.${NC}"
      fi
    done
  fi

  echo ""

  # ── Advanced options ──
  echo -e "${BOLD}── Advanced (press Enter for defaults) ──${NC}"
  echo ""

  ask "Poll interval in ms [750]: "
  read -r input_interval
  POLL_INTERVAL="${input_interval:-750}"

  ask "Log level (debug/info/warn/error) [info]: "
  read -r input_loglevel
  LOG_LEVEL="${input_loglevel:-info}"

  echo ""

  # ── Confirm ──
  echo -e "${BOLD}── Summary ──${NC}"
  echo ""
  echo "  Wallboard:    $WALLBOARD_URL"
  echo "  API Key:      ${API_KEY:0:12}..."
  echo "  PBX URL:      $PBX_URL"
  echo "  PBX Ext:      $PBX_EXT"
  echo "  Poll:         ${POLL_INTERVAL}ms"
  echo "  Log Level:    $LOG_LEVEL"
  if [[ -n "$AUTOPAGER_URL" ]]; then
    echo "  Auto-Pager:   $AUTOPAGER_URL"
    echo "  AP Key:       ${AUTOPAGER_KEY:0:12}..."
  fi
  echo ""

  ask "Proceed with installation? [Y/n]: "
  read -r confirm
  if [[ "$confirm" =~ ^[Nn] ]]; then
    echo "Aborted."
    exit 0
  fi
  echo ""
fi

# ─── Validate Required Fields ────────────────────────────────────

if [[ -z "$WALLBOARD_URL" || -z "$API_KEY" || -z "$PBX_URL" || -z "$PBX_EXT" || -z "$PBX_PASS" ]]; then
  error "Missing required fields. Run with --help for usage."
fi

# ─── Install prerequisites ───────────────────────────────────────

# Install curl if missing (3CX Debian may not have it)
if ! command -v curl &>/dev/null; then
  info "Installing curl..."
  apt-get update -qq && apt-get install -y -qq curl
fi

# ─── Check/Install Node.js ───────────────────────────────────────

NODE_INSTALLED_BY_US=false

check_node() {
  if command -v node &>/dev/null; then
    local version
    version=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ "$version" -ge "$REQUIRED_NODE_MAJOR" ]]; then
      info "Node.js $(node -v) found"
      return 0
    else
      warn "Node.js $(node -v) is too old (need v${REQUIRED_NODE_MAJOR}+)"
      return 1
    fi
  fi
  return 1
}

install_node() {
  info "Installing Node.js ${REQUIRED_NODE_MAJOR}.x..."
  NODE_INSTALLED_BY_US=true

  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x | bash -
    apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x | bash -
    yum install -y nodejs
  else
    error "Unsupported package manager. Please install Node.js ${REQUIRED_NODE_MAJOR}+ manually."
  fi

  if ! check_node; then
    error "Node.js installation failed"
  fi
}

if ! check_node; then
  install_node
fi

# ─── Stop Existing Service ────────────────────────────────────────

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  info "Stopping existing ${SERVICE_NAME} service..."
  systemctl stop "$SERVICE_NAME"
fi

# ─── Download Relay Agent ────────────────────────────────────────

info "Downloading 3cxtools-relay from GitHub..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"

BRANCH="main"
DOWNLOAD_BASE="${REPO_URL}/raw/${BRANCH}/3cxtools-relay"

# Download source files and build locally
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

info "Downloading source files..."
for file in package.json tsconfig.json src/index.ts src/collector.ts src/config.ts src/monitor.ts src/pusher.ts src/state-manager.ts; do
  mkdir -p "$TMP_DIR/$(dirname $file)"
  curl -fsSL "${DOWNLOAD_BASE}/${file}" -o "$TMP_DIR/$file" || error "Failed to download $file"
done

info "Installing dependencies..."
cd "$TMP_DIR"
npm install --production=false 2>/dev/null

info "Building TypeScript..."
npx tsc

info "Copying to ${INSTALL_DIR}..."
cp -r "$TMP_DIR/dist/"* "$INSTALL_DIR/"
cp "$TMP_DIR/package.json" "$INSTALL_DIR/"

info "Installing production dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>/dev/null

# ─── Write Config ─────────────────────────────────────────────────

info "Writing config to ${CONFIG_DIR}/config.json..."

AUTOPAGER_FIELDS=""
if [[ -n "$AUTOPAGER_URL" && -n "$AUTOPAGER_KEY" ]]; then
  AUTOPAGER_FIELDS=",
  \"autoPagerUrl\": \"${AUTOPAGER_URL}\",
  \"autoPagerApiKey\": \"${AUTOPAGER_KEY}\""
  info "Auto-Pager configured: ${AUTOPAGER_URL}"
fi

cat > "${CONFIG_DIR}/config.json" <<CONFIGEOF
{
  "wallboardUrl": "${WALLBOARD_URL}",
  "apiKey": "${API_KEY}",
  "pbxUrl": "${PBX_URL}",
  "pbxExtension": "${PBX_EXT}",
  "pbxPassword": "${PBX_PASS}",
  "pollIntervalMs": ${POLL_INTERVAL},
  "logLevel": "${LOG_LEVEL}"${AUTOPAGER_FIELDS}
}
CONFIGEOF

chmod 600 "${CONFIG_DIR}/config.json"

# Track what we installed so uninstall can clean up completely
echo "$NODE_INSTALLED_BY_US" > "${CONFIG_DIR}/.node_installed_by_relay"

# ─── Create systemd Service ──────────────────────────────────────

info "Creating systemd service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICEEOF
[Unit]
Description=3CXTools-Relay
After=network.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(command -v node) ${INSTALL_DIR}/index.js
WorkingDirectory=${INSTALL_DIR}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/
ReadWritePaths=${CONFIG_DIR}
PrivateTmp=true

# Environment
Environment=NODE_ENV=production
Environment=NODE_TLS_REJECT_UNAUTHORIZED=0

[Install]
WantedBy=multi-user.target
SERVICEEOF

# ─── Enable and Start ────────────────────────────────────────────

info "Enabling and starting service..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

sleep 2

# ─── Status ───────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo ""
if systemctl is-active --quiet "$SERVICE_NAME"; then
  info "3CXTools-Relay is running!"
else
  warn "Service may have failed to start. Check logs below."
fi
echo ""
echo "  Service:  ${SERVICE_NAME}"
echo "  Install:  ${INSTALL_DIR}"
echo "  Config:   ${CONFIG_DIR}/config.json"
echo "  Logs:     journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "  Commands:"
echo "    systemctl status ${SERVICE_NAME}    # Check status"
echo "    systemctl restart ${SERVICE_NAME}   # Restart"
echo "    systemctl stop ${SERVICE_NAME}      # Stop"
echo "    journalctl -u ${SERVICE_NAME} -n 50 # Recent logs"
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo ""

journalctl -u "$SERVICE_NAME" -n 10 --no-pager 2>/dev/null || true
