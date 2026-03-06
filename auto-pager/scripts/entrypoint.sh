#!/bin/bash
set -e

echo "[AutoPager] Starting 3CX Auto-Pager..."

# Always force-copy our Asterisk configs (overwrite Debian defaults)
if [ -d /etc/asterisk-templates ]; then
  for f in /etc/asterisk-templates/*.conf; do
    fname=$(basename "$f")
    cp "$f" "/etc/asterisk/$fname"
    echo "[AutoPager] Applied Asterisk config: $fname"
  done
fi

# Start Asterisk in background (if SIP is configured)
if [ -f /etc/asterisk/pjsip.conf ]; then
  echo "[AutoPager] Starting Asterisk..."
  asterisk -f &
  ASTERISK_PID=$!
  sleep 2
  echo "[AutoPager] Asterisk started (PID: $ASTERISK_PID)"
fi

# Start Node.js app
echo "[AutoPager] Starting Node.js application..."
exec node /app/dist/index.js
