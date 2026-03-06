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

AUTO_YES=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --yes|-y) AUTO_YES=true; shift ;;
    *) shift ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo -e "${RED}[ERROR]${NC} This script must be run as root (use sudo)"
  exit 1
fi

echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}   3CX Relay Agent — Uninstaller${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo ""

# Check if Node.js was installed by us
NODE_INSTALLED_BY_US=false
if [[ -f "${CONFIG_DIR}/.node_installed_by_relay" ]]; then
  NODE_INSTALLED_BY_US=$(cat "${CONFIG_DIR}/.node_installed_by_relay")
fi

echo -e "${CYAN}This will remove:${NC}"
echo "  - systemd service: ${SERVICE_NAME}"
echo "  - Install directory: ${INSTALL_DIR}"
echo "  - Config directory: ${CONFIG_DIR}"
if [[ "$NODE_INSTALLED_BY_US" == "true" ]]; then
  echo "  - Node.js (installed by relay agent)"
  echo "  - NodeSource apt repository"
fi
echo ""

if [[ "$AUTO_YES" != true ]]; then
  echo -en "${CYAN}Are you sure? [y/N]: ${NC}"
  read -r confirm
  if [[ ! "$confirm" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
  fi
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

# Remove Node.js if we installed it
if [[ "$NODE_INSTALLED_BY_US" == "true" ]]; then
  info "Removing Node.js..."
  if command -v apt-get &>/dev/null; then
    apt-get remove -y --purge nodejs 2>/dev/null || true
    apt-get autoremove -y 2>/dev/null || true
    # Remove NodeSource repo
    rm -f /etc/apt/sources.list.d/nodesource.list
    rm -f /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
    rm -f /usr/share/keyrings/nodesource.gpg 2>/dev/null || true
    apt-get update -qq 2>/dev/null || true
  elif command -v yum &>/dev/null; then
    yum remove -y nodejs 2>/dev/null || true
    rm -f /etc/yum.repos.d/nodesource*.repo 2>/dev/null || true
  fi
  info "Node.js removed"
fi

echo ""
info "3CX Relay Agent has been completely removed. No traces left."
echo ""
