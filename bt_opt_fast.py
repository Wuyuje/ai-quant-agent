#!/usr/bin/env python3
"""震荡策略优化 — 精简版(缓存数据, 快速)"""
import urllib.request, json, time, math, os, sys
sys.stdout.reconfigure(line_buffering=True)
exec(open("/app/workspace/ai-quant-agent/bt_range_v5_current.py").read().split("SYMS = [")[0])

SYMS = ['DOGEUSDT','ETHUSDT','SOLUSDT','ADAUSDT','XRPUSDT','DOTUSDT','APTUSDT','LINKUSDT','LTCUSDT','SUIUSDT','AVAXUSDT','INJUSDT']
CACHE = "/tmp/bt_cache_15m.json"

# 一次性拉数据并缓存
if os.path.exists(CACHE):
    DATA = json.load(open(CACHE))
    print(f"用缓存数据 ({len(DATA)}币)", flush=True)
else:
    DATA = {}
    for sym in SYMS:
        kl = get_k(sym, '15m', pages=6)
        if len(kl) >= 200: DATA[sym] = kl
        print(f"拉取 {sym}: {len(kl)}根", flush=True)
    json.dump(DATA, open(CACHE, "w"))
print(f"数据就绪: {len(DATA)}币", flush=True)

def bt(kl, opt):
    bb = bollinger(kl, CFG['bbPeriod'], CFG['bbStd'])
    atr = atr_calc(kl, CFG['atrPeriod'])
    st = supertrend(kl, CFG['stPeriod'], CFG['stMultiplier'])
    pos=None; trades=[]; pnl=0.0; L=CFG['leverage']
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
            if not er and opt.get('super_exit'):
                if side=='LONG' and s['dir']==-1: er='SUPER'
                elif side=='SHORT' and s['dir']==1: er='SUPER'
            if er:
                p=roi/100.0 - FEE*2*L
                pnl+=p; trades.append({'roi':roi,'reason':er,'pnl':p}); pos=None
            continue
        if a/price*100 < CFG['minAtrPct']: continue
        bw=bw_percentile(bb,i,CFG['bwPercentileLookback'])
        if bw and bw>CFG['bandwidthOpenAllow']: continue
        tL=price<=b['lower']; tU=price>=b['upper']
        nL=price<=(b['mid']-(b['mid']-b['lower'])*0.6); nU=price>=(b['mid']+(b['upper']-b['mid'])*0.6)
        if (tL or nL) and s['dir']==1: pos={'side':'LONG','entry':price,'time':k['t']}
        elif (tU or nU) and s['dir']==-1: pos={'side':'SHORT','entry':price,'time':k['t']}
    return trades, pnl

def run(name, opt):
    T=0;W=0;P=0.0;coins=0
    for sym,kl in DATA.items():
        if sym in CFG['blacklist']: continue
        tr,p=bt(kl,opt)
        if not tr: continue
        w=sum(1 for t in tr if t['pnl']>0)
        T+=len(tr);W+=w;P+=p
        if p>0: coins+=1
    print(f"{name:38s} {T:5d}笔 胜率{100*W/max(1,T):5.1f}% 盈亏{P:+7.2f} 每单{P/max(1,T):+.4f} 盈利币{coins}", flush=True)
    return P

print("\n═══ 离场方案对比 ═══", flush=True)
run("当前v5: SUPER无条件离场", {'tp':6,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3,'super_exit':True})
run("方案A: 去掉SUPER离场", {'tp':6,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3,'super_exit':False})
print("", flush=True)
print("═══ 止盈优化(无SUPER离场) ═══", flush=True)
for tp in [3,4,5,6,8,10]:
    run(f"  止盈{tp}%", {'tp':tp,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3,'super_exit':False})
print("", flush=True)
print("═══ 止损优化(无SUPER离场, 止盈6%) ═══", flush=True)
for sl in [1.0,1.5,2.0,2.5,3.0,4.0]:
    run(f"  {sl}ATR止损", {'tp':6,'atr_sl':sl,'total_sl':8,'max_h':2,'time_sl':3,'super_exit':False})
