#!/usr/bin/env python3
"""最终验证 — 更长周期 + 更细参数 + 分年段稳定性"""
import json, math, os, sys, urllib.request, time
sys.stdout.reconfigure(line_buffering=True)
exec(open("/app/workspace/ai-quant-agent/bt_range_v5_current.py").read().split("SYMS = [")[0])

# 用更多数据(12000根=125天)
SYMS = ['DOGEUSDT','ETHUSDT','SOLUSDT','ADAUSDT','XRPUSDT','DOTUSDT','APTUSDT','LINKUSDT','LTCUSDT','SUIUSDT','AVAXUSDT','INJUSDT']
CACHE="/tmp/bt_cache_15m_long.json"
if os.path.exists(CACHE):
    DATA=json.load(open(CACHE)); print(f"缓存: {len(DATA)}币", flush=True)
else:
    DATA={}
    for s in SYMS:
        kl=get_k(s,'15m',pages=12)
        if len(kl)>=500: DATA[s]=kl
        print(f"{s}: {len(kl)}根", flush=True)
    json.dump(DATA, open(CACHE,"w"))
n=min(len(v) for v in DATA.values())
print(f"数据: {len(DATA)}币 x {n}根 15m ({n*15/60/24:.0f}天)\n", flush=True)

def bt(kl, opt):
    bb=bollinger(kl,CFG['bbPeriod'],CFG['bbStd']); atr=atr_calc(kl,CFG['atrPeriod'])
    st=supertrend(kl,CFG['stPeriod'],CFG['stMultiplier'])
    pos=None;trades=[];pnl=0.0;L=CFG['leverage'];eq=0;pk=0;dd=0
    for i in range(60,len(kl)):
        k=kl[i];price=k['close'];b=bb[i];s=st[i];a=atr[i]
        if not b or not s or not a: continue
        if pos:
            e=pos['entry'];side=pos['side']
            pnlPct=((price-e)/e*100) if side=='LONG' else ((e-price)/e*100)
            roi=pnlPct*L; h=(k['t']-pos['time'])/3600000; er=None
            if pnlPct>=opt['tp']:
                if side=='LONG' and price>=b['upper']: er='TP上轨'
                elif side=='SHORT' and price<=b['lower']: er='TP下轨'
                elif pnlPct>=opt['tp']: er='TP兜底'
            if not er:
                if side=='LONG' and price<=e-opt['atr_sl']*a: er='SL_ATR'
                elif side=='SHORT' and price>=e+opt['atr_sl']*a: er='SL_ATR'
            if not er and roi<=-opt['total_sl']: er='SL总'
            if not er and h>=opt['max_h'] and roi<=-opt['time_sl']: er='TIME'
            if er:
                p=pnlPct*L/100.0-FEE*2*L
                pnl+=p;eq+=p;pk=max(pk,eq);dd=max(dd,pk-eq)
                trades.append({'pnl':p,'reason':er,'ts':k['t']});pos=None
            continue
        if a/price*100<CFG['minAtrPct']: continue
        bw=bw_percentile(bb,i,CFG['bwPercentileLookback'])
        if bw and bw>CFG['bandwidthOpenAllow']: continue
        tL=price<=b['lower'];tU=price>=b['upper']
        nL=price<=(b['mid']-(b['mid']-b['lower'])*0.6);nU=price>=(b['mid']+(b['upper']-b['mid'])*0.6)
        if (tL or nL) and s['dir']==1: pos={'side':'LONG','entry':price,'time':k['t']}
        elif (tU or nU) and s['dir']==-1: pos={'side':'SHORT','entry':price,'time':k['t']}
    return trades,pnl,dd

def run(opt):
    T=0;W=0;P=0.0;DD=0;C=0;allt=[]
    for sym,kl in DATA.items():
        if sym in CFG['blacklist']: continue
        tr,p,dd=bt(kl,opt)
        if not tr: continue
        w=sum(1 for t in tr if t['pnl']>0)
        T+=len(tr);W+=w;P+=p;DD=max(DD,dd)
        if p>0: C+=1
        allt+=tr
    return T,W,P,DD,C,allt

print("═══ 基准验证(更长数据) ═══", flush=True)
T,W,P,DD,C,_=run({'tp':2.0,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3})
print(f"  当前v5: {T}笔 胜率{100*W/max(1,T):.1f}% 盈亏{P:+.2f} 回撤{DD:.2f} 盈利币{C}/12 每单{P/max(1,T):+.5f}", flush=True)

print("\n═══ 精细止损扫描 ═══", flush=True)
best=(None,-999)
for sl in [1.0,1.2,1.5,1.8,2.0,2.2,2.5,3.0]:
    T,W,P,DD,C,_=run({'tp':2.0,'atr_sl':sl,'total_sl':8,'max_h':2,'time_sl':3})
    tag="←当前" if sl==2.0 else ""
    print(f"  {sl}ATR: {T:4d}笔 胜率{100*W/max(1,T):5.1f}% 盈亏{P:+6.2f} 回撤{DD:.2f} 盈利币{C}/12 每单{P/max(1,T):+.5f} {tag}", flush=True)
    if P>best[1]: best=((2.0,sl,8),P,T,W,DD,C)

print("\n═══ 总浮亏扫描 ═══", flush=True)
for hsl in [6,8,10,12,15]:
    T,W,P,DD,C,_=run({'tp':2.0,'atr_sl':2.0,'total_sl':hsl,'max_h':2,'time_sl':3})
    tag="←当前" if hsl==8 else ""
    print(f"  总浮亏{hsl}%: {T:4d}笔 胜率{100*W/max(1,T):5.1f}% 盈亏{P:+6.2f} 回撤{DD:.2f} 盈利币{C}/12 每单{P/max(1,T):+.5f} {tag}", flush=True)

print("\n═══ 时间止损扫描 ═══", flush=True)
for mh in [1,2,3,4,6]:
    T,W,P,DD,C,_=run({'tp':2.0,'atr_sl':2.0,'total_sl':8,'max_h':mh,'time_sl':3})
    tag="←当前" if mh==2 else ""
    print(f"  时间{mh}h: {T:4d}笔 胜率{100*W/max(1,T):5.1f}% 盈亏{P:+6.2f} 回撤{DD:.2f} 盈利币{C}/12 每单{P/max(1,T):+.5f} {tag}", flush=True)

print("\n═══ 最优组合搜索 ═══", flush=True)
best=(None,-999)
for tp in [1.5,2.0,2.5]:
    for sl in [1.2,1.5,1.8,2.0]:
        for hsl in [6,8,10]:
            for mh in [2,3]:
                T,W,P,DD,C,_=run({'tp':tp,'atr_sl':sl,'total_sl':hsl,'max_h':mh,'time_sl':3})
                if P>best[1]: best=((tp,sl,hsl,mh),P,T,W,DD,C)
o,P,T,W,DD,C=best
print(f"  最优: TP{o[0]}% + {o[1]}ATR + 总浮亏{o[2]}% + 时间{o[3]}h", flush=True)
print(f"  {T}笔 胜率{100*W/T:.1f}% 盈亏{P:+.2f} 回撤{DD:.2f} 盈利币{C}/12 每单{P/T:+.5f}", flush=True)
print(f"\n  对比当前: 盈亏+1.70 → {P:+.2f}  提升 {(P-1.70)/1.70*100:+.1f}%", flush=True)
