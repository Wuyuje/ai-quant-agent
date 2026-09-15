#!/usr/bin/env python3
"""震荡策略最终优化 — 精细网格搜索"""
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
    peak_eq=0; max_dd=0; eq=0
    for i in range(60, len(kl)):
        k=kl[i]; price=k['close']; b=bb[i]; s=st[i]; a=atr[i]
        if not b or not s or not a: continue
        if pos:
            entry=pos['entry']; side=pos['side']
            roi=((price-entry)/entry*100*L) if side=='LONG' else ((entry-price)/entry*100*L)
            held_h=(k['t']-pos['time'])/3600000
            er=None
            if side=='LONG' and price>=b['upper']: er='TP上轨'
            elif side=='SHORT' and price<=b['lower']: er='TP下轨'
            if not er and roi>=opt['tp']: er='TP兜底'
            if not er:
                if side=='LONG' and price<=entry-opt['atr_sl']*a: er='SL_ATR'
                elif side=='SHORT' and price>=entry+opt['atr_sl']*a: er='SL_ATR'
            if not er and roi<=-opt['total_sl']: er='SL总'
            if not er and held_h>=opt['max_h'] and roi<=-opt['time_sl']: er='TIME'
            if not er and opt.get('trail'):
                pos['peak']=max(pos.get('peak',roi),roi)
                if pos['peak']>=opt['trail_trigger'] and roi<=pos['peak']-opt['trail_dd']: er='TRAIL'
            if er:
                p=roi/100.0 - FEE*2*L
                pnl+=p; eq+=p; peak_eq=max(peak_eq,eq); max_dd=max(max_dd,peak_eq-eq)
                trades.append({'roi':roi,'reason':er,'pnl':p}); pos=None
            continue
        if a/price*100 < CFG['minAtrPct']: continue
        bw=bw_percentile(bb,i,CFG['bwPercentileLookback'])
        if bw and bw>CFG['bandwidthOpenAllow']: continue
        tL=price<=b['lower']; tU=price>=b['upper']
        nL=price<=(b['mid']-(b['mid']-b['lower'])*0.6); nU=price>=(b['mid']+(b['upper']-b['mid'])*0.6)
        if (tL or nL) and s['dir']==1: pos={'side':'LONG','entry':price,'time':k['t'],'peak':0}
        elif (tU or nU) and s['dir']==-1: pos={'side':'SHORT','entry':price,'time':k['t'],'peak':0}
    return trades, pnl, max_dd

def run(opt, label=""):
    T=0;W=0;P=0.0;DD=0;coins=0;reasons={}
    for sym,kl in DATA.items():
        if sym in CFG['blacklist']: continue
        tr,p,dd=bt(kl,opt)
        if not tr: continue
        w=sum(1 for t in tr if t['pnl']>0)
        T+=len(tr);W+=w;P+=p;DD=max(DD,dd)
        if p>0: coins+=1
        for t in tr: reasons[t['reason']]=reasons.get(t['reason'],0)+t['pnl']
    return T,W,P,DD,coins,reasons

# 网格搜索: 止盈 x 止损 x 移动止盈
print("\n═══ 网格搜索: 止盈 x ATR止损 x 移动止盈 ═══", flush=True)
best=(None,-999)
for tp in [4,6,8,10,15]:
    for sl in [2.0,2.5,3.0,4.0]:
        for trail in [0, 3, 5]:
            opt={'tp':tp,'atr_sl':sl,'total_sl':8,'max_h':2,'time_sl':3}
            if trail:
                opt['trail']=True; opt['trail_trigger']=trail; opt['trail_dd']=2.0
            T,W,P,DD,coins,_=run(opt)
            tag=f"TP{tp}% SL{sl}ATR"+(f" TRAIL{trail}%" if trail else "")
            if P>best[1]: best=(opt,P,T,100*W/max(1,T),DD,coins,tag)
            if P>1.3:
                print(f"  {tag:32s} {T:5d}笔 胜率{100*W/max(1,T):5.1f}% 盈亏{P:+6.2f} 回撤{DD:.2f} 盈利币{coins}", flush=True)

print(f"\n═══ 最优 ═══", flush=True)
o,P,T,WR,DD,coins,tag=best
print(f"  {tag}", flush=True)
print(f"  {T}笔 胜率{WR:.1f}% 盈亏{P:+.2f} 最大回撤{DD:.2f} 盈利币{coins}/11", flush=True)
print(f"  每单期望: {P/T:+.4f}", flush=True)

# 逐币明细
print(f"\n═══ 最优方案逐币 ═══", flush=True)
for sym,kl in DATA.items():
    if sym in CFG['blacklist']: continue
    tr,p,dd=bt(kl,o)
    if not tr: continue
    w=sum(1 for t in tr if t['pnl']>0)
    print(f"  {sym:10s} {len(tr):4d}笔 胜率{100*w/len(tr):5.1f}% 盈亏{p:+6.2f}", flush=True)
