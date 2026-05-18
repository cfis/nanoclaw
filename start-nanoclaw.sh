#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/yue/src/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/home/yue/src/nanoclaw"

# Stop existing instance if running
if [ -f "/home/yue/src/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/yue/src/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/home/yue/src/nanoclaw/dist/index.js" \
  >> "/home/yue/src/nanoclaw/logs/nanoclaw.log" \
  2>> "/home/yue/src/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/home/yue/src/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/yue/src/nanoclaw/logs/nanoclaw.log"
