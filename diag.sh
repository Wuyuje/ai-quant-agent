#!/bin/bash
cd /app/workspace/ai-quant-agent 2>/dev/null || exit 1
echo "== open switches (pause-trading) =="
cat data/pause-trading.json 2>/dev/null | grep -E "pause(Open|Trend|Boll)"
echo "== engine =="
curl -s -m5 localhost:10060/api/quant/health 2>/dev/null; echo
echo "== agents positions =="
curl -s -m5 localhost:10060/api/quant/agents > /tmp/ag.json 2>/dev/null
cd /app/workspace && /usr/local/bin/python3 - <<PY 2>/dev/null
import json
try:
    d=json.load(open('/tmp/ag.json'))
    for a in d.get('agents',[]):
        w=a.get('wallet','')[:10]
        role='admin' if a.get('isAdmin') else ('wh' if a.get('isWhitelist') else 'usr')
        print(w, role, 'pos=',a.get('positionCount'), 'balances=', round(a.get('balance') or 0,1))
except Exception as e:
    print('agents read err', e)
PY
echo "== recent actual opens (from q.log, tail) =="
grep -aE "开仓|顺势开|break.*开|趋势.*开|波段.*开" /tmp/q.log 2>/dev/null | tail -6
