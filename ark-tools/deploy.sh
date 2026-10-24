#!/usr/bin/env bash
# ARK Citizen Tools - one-click deploy (Docker, fallback to node)
set -e
cd "$(dirname "$0")"
PORT="${PORT:-18080}"

echo "=== ARK Citizen Tools deploy ==="

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "[1/3] Docker mode"
  docker compose down 2>/dev/null || true
  docker compose up -d --build
  echo "[2/3] waiting..."
  sleep 4
  docker compose ps
  echo "[3/3] URL: http://<SERVER_IP>:${PORT}"
  exit 0
fi

echo "[1/3] Node mode (docker unavailable)"
if ! command -v node >/dev/null 2>&1; then
  echo "node not found. install nodejs first." >&2
  exit 1
fi
mkdir -p state
PIDFILE="ark-tools.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 1
fi
PORT="$PORT" nohup node server.mjs > ark-tools.log 2>&1 &
echo $! > "$PIDFILE"
sleep 2
echo "[2/3] pid $(cat "$PIDFILE")"
tail -n 5 ark-tools.log 2>/dev/null || true
echo "[3/3] URL: http://<SERVER_IP>:${PORT}"
