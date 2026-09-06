#!/bin/bash
QA=/app/workspace/ai-quant-agent
cd "$QA" || exit 1
pkill -9 -f "quant/start" 2>/dev/null
pkill -9 -f "saas/start" 2>/dev/null
sleep 1
setsid nohup node quant/start.js > /tmp/q.log 2>&1 &
setsid nohup node saas/start.js > /tmp/saas.log 2>&1 &
for i in $(seq 1 12); do sleep 2; :; done
echo "PORTS:"
for P in 10060 10020; do
  if ss -ltn 2>/dev/null | grep -q ":$P "; then echo "  $P:UP"; else echo "  $P:DOWN"; fi
done
echo -n "HEALTH:"
curl -s -m5 localhost:10060/api/quant/health 2>/dev/null
echo
echo "QLOG:"
tail -6 /tmp/q.log 2>/dev/null
