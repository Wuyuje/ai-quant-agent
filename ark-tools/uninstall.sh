#!/usr/bin/env bash
# ARK Citizen Tools - full removal
set -e
cd "$(dirname "$0")"
echo "=== ARK Citizen Tools uninstall ==="
if command -v docker >/dev/null 2>&1; then
  docker compose down -v 2>/dev/null || true
  docker rmi "$(basename "$PWD")-ark-tools" 2>/dev/null || true
fi
if [ -f ark-tools.pid ]; then
  kill "$(cat ark-tools.pid)" 2>/dev/null || true
  rm -f ark-tools.pid
fi
rm -rf state ark-tools.log
echo "done. (source files kept; delete the folder to remove entirely)"
