#!/bin/bash
echo "=== 量化机器人状态 ==="
echo ""
echo "1. 主进程:"
ps aux | grep "start.js" | grep -v grep | awk '{print "   PID="$2" CPU="$3"% MEM="$4"% 运行时间="$10}'
echo ""
echo "2. 守护进程:"
ps aux | grep "guardian-daemon" | grep -v grep | awk '{print "   PID="$2}'
echo ""
echo "3. 端口:"
ss -ltnp | grep 8010 | awk '{print "   "$4}'
echo ""
echo "4. 资源:"
echo "   内存: $(free -m | awk '/Mem:/ {printf "%dMB/%dMB (%d%%)", $3, $2, $3*100/$2}')"
echo "   磁盘: $(df -h / | tail -1 | awk '{print $3"/"$2" ("$5")"}')"
echo ""
echo "5. 最近日志:"
tail -3 /app/workspace/ai-quant-agent/data/guardian.log | sed 's/^/   /'
