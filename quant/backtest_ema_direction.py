#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EMA 策略「方向正确性」专项回测 v2
检查 EMA 策略开仓会不会把趋势方向开反(该做多却做空)。
用大级别 EMA200 + 更长周期动量 作为「真趋势」基准, 判断 EMA 每笔开仓是否逆大趋势。
数据源: 币安真实K线(与实盘一致)。
"""
import json, urllib.request
from collections import Counter

def get_klines(symbol, interval='15m', limit=1000):
    url=f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}"
    req=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
    return [{'o':float(k[1]),'h':float(k[2]),'l':float(k[3]),'c':float(k[4]),'v':float(k[5])} for k in json.load(urllib.request.urlopen(req,timeout=20))]

def ema(vals,n):
    k=2/(n+1);e=vals[0];out=[e]
    for v in vals[1:]: e=v*k+e*(1-k); out.append(e)
    return out

COINS = ['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','ADAUSDT','XRPUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','ARBUSDT','SUIUSDT']

# EMA策略开仓信号 (复刻 trend-strategy.js entrySignal)
def ema_signal(closes, vols, i):
    if i<99: return None
    e7=ema(closes[:i+1],7)[-1]; e25=ema(closes[:i+1],25)[-1]; e99=ema(closes[:i+1],99)[-1]
    if not (e7>e25>e99 or e7<e25<e99): return None
    up = e7>e25>e99
    price=closes[i]; pv_hi=max(closes[i-30:i]); pv_lo=min(closes[i-30:i])
    mom=(price-closes[i-5])/(closes[i-5] or 1)*100
    avgVol=sum(vols[i-20:i])/20 if i>=20 else 1
    volRatio=vols[i]/avgVol if avgVol>0 else 1
    if up:
        if price>pv_hi and mom>0 and volRatio>1.2: return 'LONG'
        if price>pv_hi: return 'LONG'
    else:
        if price<pv_lo and mom<0 and volRatio>1.2: return 'SHORT'
        if price<pv_lo: return 'SHORT'
    return None

# 大趋势基准: EMA200(更长期)方向
def big_trend(closes, i):
    if i<200: return None
    e200=ema(closes[:i+1],200)[-1]
    return 'UP' if closes[i]>e200 else 'DOWN'

def run(symbol, interval='15m', hold=8):
    raw=get_klines(symbol,interval)
    if len(raw)<300: return None
    closes=[k['c'] for k in raw]; vols=[k['v'] for k in raw]
    trades=[]; in_pos=False
    for i in range(99,len(raw)-hold):
        if in_pos:
            in_pos=False; continue  # 持仓跳过(简化)
        sig=ema_signal(closes,vols,i)
        if not sig: continue
        entry=closes[i]; exit=closes[i+hold]
        pnl=(exit-entry)/entry if sig=='LONG' else (entry-exit)/entry
        big=big_trend(closes,i)
        aligned = (sig=='LONG' and big=='UP') or (sig=='SHORT' and big=='DOWN')
        trades.append({'dir':sig,'big':big,'aligned':aligned,'pnl':pnl})
        in_pos=True
    return trades

def st(ts):
    if not ts: return (0,0,0)
    wr=sum(1 for t in ts if t['pnl']>0)/len(ts)*100
    return (len(ts),round(wr,1),round(sum(t['pnl'] for t in ts)/len(ts)*100,3))

print("═══ EMA策略「方向正确性」回测 (币安15m 持有8根) ═══")
g_a=[0,0,0]; g_c=[0,0,0]; contra_total=0
for sym in COINS:
    try:
        ts=run(sym)
        if not ts: continue
        al=[t for t in ts if t['aligned']]; ct=[t for t in ts if not t['aligned']]
        na,wa,aa=st(al); nc,wc,ac=st(ct)
        contra_total+=nc
        g_a[0]+=na;g_c[0]+=nc
        g_a[1]+=wa*na;g_c[1]+=wc*nc
        g_a[2]+=aa*na;g_c[2]+=ac*nc
        flag='⚠️' if nc and aa<ac else ''
        print(f"{sym:10} 顺势{na}笔/胜{wa}%/均{aa:+.2f}% | 逆势{nc}笔/胜{wc}%/均{ac:+.2f}% {flag}")
    except Exception as e:
        print(f"{sym:10} err {str(e)[:25]}")
gsa=len([t for s in COINS for t in run(s) if t.get('dir')=='SHORT' and not t.get('aligned')])
# 汇总
wa=g_a[1]/g_a[0] if g_a[0] else 0; aa=g_a[2]/g_a[0] if g_a[0] else 0
wc=g_c[1]/g_c[0] if g_c[0] else 0; ac=g_c[2]/g_c[0] if g_c[0] else 0
print("\n═══ 汇总 ═══")
print(f"顺大趋势: {g_a[0]}笔 胜率{wa:.1f}% 均单{aa:+.3f}%")
print(f"逆大趋势: {g_c[0]}笔 胜率{wc:.1f}% 均单{ac:+.3f}%")
