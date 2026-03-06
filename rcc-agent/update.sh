#!/bin/bash
# Update the RCC Relay Agent from GitHub
# Usage: sudo bash /opt/reditech-relay-agent/update.sh

set -e

INSTALL_DIR="/opt/reditech-relay-agent"
REPO_URL="https://github.com/REDiTECH-NOC/3CX-Tools-Suite.git"
TMP_DIR=$(mktemp -d)

echo "[Update] Pulling latest from GitHub..."
git clone --depth 1 "$REPO_URL" "$TMP_DIR" 2>/dev/null

echo "[Update] Copying rcc-agent source..."
cp -r "$TMP_DIR/rcc-agent/src" "$INSTALL_DIR/"
cp "$TMP_DIR/rcc-agent/package.json" "$INSTALL_DIR/"
cp "$TMP_DIR/rcc-agent/tsconfig.json" "$INSTALL_DIR/"
cp "$TMP_DIR/rcc-agent/update.sh" "$INSTALL_DIR/"
cp "$TMP_DIR/rcc-agent/.env.example" "$INSTALL_DIR/" 2>/dev/null || true
cp "$TMP_DIR/rcc-agent/systemd/relay-agent.service" "$INSTALL_DIR/systemd/" 2>/dev/null || true

echo "[Update] Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>/dev/null
npm run build

echo "[Update] Fixing permissions..."
chown -R reditech:reditech "$INSTALL_DIR"

echo "[Update] Restarting service..."
systemctl restart relay-agent

rm -rf "$TMP_DIR"

echo "[Update] Done. Status:"
systemctl status relay-agent --no-pager -l | head -15
