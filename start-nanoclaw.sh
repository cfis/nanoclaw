#!/bin/bash
# start-nanoclaw.sh — Restart NanoClaw via systemd
# The service is managed by: nanoclaw-v2-b824edf6.service (Restart=always)
# Use systemctl for all lifecycle operations — do NOT use nohup/manual spawn.

set -euo pipefail

UNIT="nanoclaw.service"

echo "Restarting NanoClaw via systemd..."
systemctl --user restart "$UNIT"
echo "NanoClaw restarted (systemd unit: $UNIT)"
echo "Status: systemctl --user status $UNIT"
echo "Logs:   journalctl --user -u $UNIT -f"
echo "  or:   tail -f /home/yue/src/nanoclaw/logs/nanoclaw.log"
