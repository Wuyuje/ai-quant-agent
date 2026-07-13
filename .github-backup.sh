#!/bin/bash
# 每小时自动备份到 GitHub
cd /app/workspace/ai-quant-agent
while true; do
  sleep 3600
  git add -A
  git diff --cached --quiet || git commit -m "auto-backup: $(date '+%Y-%m-%d %H:%M')"
  git push origin main 2>/dev/null
done
