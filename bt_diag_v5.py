#!/usr/bin/env python3
"""诊断: 当前v5策略为什么亏 — 按离场原因/方向/持有时间分析"""
import urllib.request, json, time, math
import importlib.util
spec = importlib.util.spec_from_file_location("bt", "/app/workspace/ai-quant-agent/bt_range_v5_current.py")
# 直接复用函数
exec(open("/app/workspace/ai-quant-agent/bt_range_v5_current.py").read().split("SYMS = [")[0])

SYMS = ['DOGEUSDT','ETHUSDT','SOLUSDT','ADAUSDT','XRPUSDT','DOTUSDT','APTUSDT','LINKUSDT','LTCUSDT','SUIUSDT','AVAXUSDT','INJUSDT']
alltr = []
for sym in SYMS:
    if sym in CFG['blacklist']: continue
    kl = get_k(sym, CFG['interval'], pages=6)
    if len(kl) < 200: continue
    tr, w, l, p = backtest(sym, kl)
    for t in tr: t['symbol'] = sym
    alltr += tr

print(f"═══ 诊断 {len(alltr)} 笔交易 ═══\n")
from collections import defaultdict
# 按离场原因
by_reason = defaultdict(lambda: [0,0,0.0])
for t in alltr:
    r = t['reason'].split('_')[0] if '_' in t['reason'] else t['reason']
    by_reason[t['reason']][0] += 1
    if t['pnl'] > 0: by_reason[t['reason']][1] += 1
    by_reason[t['reason']][2] += t['pnl']
print("── 按离场原因 ──")
for r in sorted(by_reason, key=lambda x: by_reason[x][2]):
    n, w, p = by_reason[r]
    print(f"  {r:20s} {n:4d}笔 胜{w:4d} ({100*w/n:5.1f}%) 盈亏{p:+.2f} 每单{p/n:+.4f}")

# 按方向
print("\n── 按方向 ──")
by_side = defaultdict(lambda: [0,0,0.0])
for t in alltr:
    by_side[t['side']][0] += 1
    if t['pnl'] > 0: by_side[t['side']][1] += 1
    by_side[t['side']][2] += t['pnl']
for s in by_side:
    n, w, p = by_side[s]
    print(f"  {s:6s} {n:4d}笔 胜率{100*w/n:5.1f}% 盈亏{p:+.2f} 每单{p/n:+.4f}")

# 盈亏分布
print("\n── 盈亏分布 ──")
gains = [t['pnl'] for t in alltr if t['pnl'] > 0]
losses = [t['pnl'] for t in alltr if t['pnl'] <= 0]
if gains: print(f"  平均盈利: {sum(gains)/len(gains):+.4f}  最大盈利: {max(gains):+.4f}")
if losses: print(f"  平均亏损: {sum(losses)/len(losses):+.4f}  最大亏损: {min(losses):+.4f}")
if gains and losses:
    print(f"  盈亏比: {abs(sum(gains)/len(gains)/(sum(losses)/len(losses))):.2f}:1")
    print(f"  需要胜率: {100*abs(sum(losses)/len(losses))/(abs(sum(losses)/len(losses))+sum(gains)/len(gains)):.1f}% 才能打平")

# 按ROI
print("\n── 离场时回报率(含杠杆) ──")
buckets = defaultdict(lambda: [0,0.0])
for t in alltr:
    roi = t['roi']
    b = int(roi//10)*10
    buckets[b][0] += 1; buckets[b][1] += t['pnl']
for b in sorted(buckets):
    n, p = buckets[b]
    print(f"  ROI {b:+4d}~{b+10:+4d}%: {n:4d}笔 盈亏{p:+.2f}")
