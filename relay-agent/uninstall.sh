#!/bin/bash
set -e

SERVICE_NAME="3cx-relay"
INSTALL_DIR="/opt/3cx-relay"
CONFIG_DIR="/etc/3cx-relay"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }

if [[ $EUID -ne 0 ]]; then
  echo -e "${RED}[ERROR]${NC} This script must be run as root (use sudo)"
  exit 1
fi

echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}   3CX Relay Agent — Uninstaller${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "${CYAN}This will remove:${NC}"
echo "  - systemd service: ${SERVICE_NAME}"
echo "  - Install directory: ${INSTALL_DIR}"
echo "  - Config directory: ${CONFIG_DIR}"
echo ""
echo -en "${CYAN}Are you sure? [y/N]: ${NC}"
read -r confirm
if [[ ! "$confirm" =~ ^[Yy] ]]; then
  echo "Aborted."
  exit 0
fi

echo ""

# Stop and disable service
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  info "Stopping ${SERVICE_NAME}..."
  systemctl stop "$SERVICE_NAME"
fi

if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  info "Disabling ${SERVICE_NAME}..."
  systemctl disable "$SERVICE_NAME"
fi

# Remove service file
if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
  info "Removing systemd service file..."
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
fi

# Remove install directory
if [[ -d "$INSTALL_DIR" ]]; then
  info "Removing ${INSTALL_DIR}..."
  rm -rf "$INSTALL_DIR"
fi

# Remove config
if [[ -d "$CONFIG_DIR" ]]; then
  info "Removing ${CONFIG_DIR}..."
  rm -rf "$CONFIG_DIR"
fi

echo ""
info "3CX Relay Agent has been removed."
echo ""
echo "  Note: Node.js was NOT removed."
echo "  To remove it: apt remove nodejs (Debian) or yum remove nodejs (RHEL)"
echo ""
