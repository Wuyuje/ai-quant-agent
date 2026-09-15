#!/usr/bin/env python3
"""震荡策略回测 v2 — 精确复现真实代码离场逻辑(无SUPER离场)
真实离场(checkTakeProfit/checkAtrStopLoss/checkTotalLossStop/checkTimeStop/checkConsecutiveLoss):
  1. 触对轨止盈(收盘价>=上轨 或 <=下轨)
  2. 浮盈>=profitTriggerPct 兜底
  3. ATR止损: 价格反向偏离atrStopMultiplier*ATR
  4. 总浮亏>=totalLossPct(含杠杆)
  5. 时间止损: >maxHoldHours 且浮亏>=maxHoldLossPct
"""
import json, math, os, sys
sys.stdout.reconfigure(line_buffering=True)
exec(open("/app/workspace/ai-quant-agent/bt_range_v5_current.py").read().split("SYMS = [")[0])

DATA = json.load(open("/tmp/bt_cache_15m.json"))
print(f"数据: {len(DATA)}币 x 6000根 15m", flush=True)

def bt(kl, opt):
    bb = bollinger(kl, CFG['bbPeriod'], CFG['bbStd'])
    atr = atr_calc(kl, CFG['atrPeriod'])
    st = supertrend(kl, CFG['stPeriod'], CFG['stMultiplier'])
    pos=None; trades=[]; pnl=0.0; L=CFG['leverage']
    eq=0; peak_eq=0; max_dd=0
    for i in range(60, len(kl)):
        k=kl[i]; price=k['close']; b=bb[i]; s=st[i]; a=atr[i]
        if not b or not s or not a: continue
        if pos:
            entry=pos['entry']; side=pos['side']
            # 真实 _calcPnlPct: 用价格%
            pnlPct = ((price-entry)/entry*100) if side=='LONG' else ((entry-price)/entry*100)
            roi = pnlPct * L
            held_h=(k['t']-pos['time'])/3600000
            er=None
            # 1) 止盈: 浮盈>=trigger 才检查
            if pnlPct >= opt['tp']:
                # 触对轨
                if side=='LONG' and price >= b['upper']: er='TP上轨'
                elif side=='SHORT' and price <= b['lower']: er='TP下轨'
                elif pnlPct >= opt['tp']: er=f'TP{opt["tp"]}%'
            # 2) ATR止损
            if not er:
                if side=='LONG' and price <= entry-opt['atr_sl']*a: er='SL_ATR'
                elif side=='SHORT' and price >= entry+opt['atr_sl']*a: er='SL_ATR'
            # 3) 总浮亏(含杠杆)
            if not er and roi <= -opt['total_sl']: er='SL总浮亏'
            # 4) 时间止损
            if not er and held_h >= opt['max_h'] and roi <= -opt['time_sl']: er='TIME'
            if er:
                # _calcPnlPct 是价格%, 实际盈亏=价格%*杠杆 - 手续费
                p = pnlPct*L/100.0 - FEE*2*L
                pnl+=p; eq+=p; peak_eq=max(peak_eq,eq); max_dd=max(max_dd,peak_eq-eq)
                trades.append({'side':side,'roi':roi,'reason':er,'pnl':p}); pos=None
            continue
        # 开仓(精确复现 checkOpenCondition)
        if a/price*100 < CFG['minAtrPct']: continue
        bw=bw_percentile(bb,i,CFG['bwPercentileLookback'])
        if bw and bw>CFG['bandwidthOpenAllow']: continue
        tL=price<=b['lower']; tU=price>=b['upper']
        nL=price<=(b['mid']-(b['mid']-b['lower'])*0.6); nU=price>=(b['mid']+(b['upper']-b['mid'])*0.6)
        if (tL or nL) and s['dir']==1: pos={'side':'LONG','entry':price,'time':k['t']}
        elif (tU or nU) and s['dir']==-1: pos={'side':'SHORT','entry':price,'time':k['t']}
    return trades, pnl, max_dd

def run(opt):
    T=0;W=0;P=0.0;DD=0;coins=0
    for sym,kl in DATA.items():
        if sym in CFG['blacklist']: continue
        tr,p,dd=bt(kl,opt)
        if not tr: continue
        w=sum(1 for t in tr if t['pnl']>0)
        T+=len(tr);W+=w;P+=p;DD=max(DD,dd)
        if p>0: coins+=1
    return T,W,P,DD,coins

print("\n═══ 基准: 当前v5 (TP2% + 2.0ATR止损) ═══", flush=True)
T,W,P,DD,C=run({'tp':2.0,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3})
print(f"  {T}笔 胜率{100*W/max(1,T):.1f}% 盈亏{P:+.2f} 回撤{DD:.2f} 盈利币{C}/12 每单{P/max(1,T):+.4f}", flush=True)

print("\n═══ 止盈扫描 (2.0ATR止损) ═══", flush=True)
for tp in [2,3,4,5,6,8,10]:
    T,W,P,DD,C=run({'tp':tp,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3})
    print(f"  TP{tp:2d}%: {T:4d}笔 胜率{100*W/max(1,T):5.1f}% 盈亏{P:+.2f} 回撤{DD:.2f} 盈利币{C}/12 每单{P/max(1,T):+.4f}", flush=True)

print("\n═══ 止损扫描 (TP2%) ═══", flush=True)
for sl in [1.5,2.0,2.5,3.0,4.0,5.0]:
    T,W,P,DD,C=run({'tp':2.0,'atr_sl':sl,'total_sl':8,'max_h':2,'time_sl':3})
    print(f"  {sl}ATR: {T:4d}笔 胜率{100*W/max(1,T):5.1f}% 盈亏{P:+.2f} 回撤{DD:.2f} 盈利币{C}/12 每单{P/max(1,T):+.4f}", flush=True)

print("\n═══ 组合扫描 ═══", flush=True)
best=(None,-999)
for tp in [2,3,4,5,6,8]:
    for sl in [2.0,2.5,3.0,4.0]:
        for hsl in [8,12,16,20]:
            T,W,P,DD,C=run({'tp':tp,'atr_sl':sl,'total_sl':hsl,'max_h':2,'time_sl':3})
            if P>best[1]: best=((tp,sl,hsl),P,T,100*W/max(1,T),DD,C)
            if P>2.0:
                print(f"  TP{tp}% SL{sl}ATR 总浮亏{hsl}%: {T:4d}笔 胜率{100*W/max(1,T):5.1f}% 盈亏{P:+.2f} 回撤{DD:.2f} 盈利币{C}/12", flush=True)
o,P,T,WR,DD,C=best
print(f"\n═══ 最优 ═══", flush=True)
print(f"  TP{o[0]}% + {o[1]}ATR止损 + 总浮亏{o[2]}%", flush=True)
print(f"  {T}笔 胜率{WR:.1f}% 盈亏{P:+.2f} 回撤{DD:.2f} 盈利币{C}/12 每单{P/T:+.4f}", flush=True)
