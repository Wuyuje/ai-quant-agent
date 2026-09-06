#!/bin/bash
LOG=/app/workspace/ai-quant-agent/logs/guard_main.log
W=/app/workspace/ai-quant-agent
S=/app/workspace/btc-simulator
mkdir -p "$(dirname "$LOG")"
say(){ echo "$(date '+%F %T') $1" >> "$LOG"; }
up(){ ss -ltn 2>/dev/null | grep -q ":$1 "; }
guard(){
  local nm=$1 port=$2 dir=$3; shift 3
  if up "$port"; then return 0; fi
  say "warn ${nm} DOWN -> restart"
  ( cd "$dir" && nohup "$@" >"$LOG" 2>&1 & )
  sleep 6
  up "$port" && say "ok ${nm} back" || say "fail ${nm} still down"
}
say "== guard START =="
while true; do
  guard quant 10060 "$W" node quant/start.js
  guard saas 10020 "$W" node saas/start.js
  guard sim   10500 "$S" node server.js
  if ! pgrep -f real_trader.js >/dev/null; then
    ( cd /app/workspace && nohup node real_trader.js >"$LOG" 2>&1 & )
    say "ok real_trader respawn"
  fi
  sleep 25
done
