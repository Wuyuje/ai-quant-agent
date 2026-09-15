#!/usr/bin/env python3
"""真趋势波段策略回测 — 精确复现 quant/trend-band-strategy.js
配置:
  开仓: EMA(7>25>99)排列 + 价格突破近60根高低 + 相对EMA50偏移>1%
  止损: stopMul ATR (当前0.8, 原设计2.5)
  止盈: 5.0 ATR + 移动止盈(0.9ATR) + 两阶段锁利(盈利≥3%后回撤1.2%)
  周期: 4h
测试目标: stopMul 0.8 vs 1.5 vs 2.0 vs 2.5
"""
import json, math, os, sys, urllib.request, time
sys.stdout.reconfigure(line_buffering=True)
UA={'User-Agent':'Mozilla/5.0'}; FEE=0.0004

CFG = {
    'interval':'4h','fast':7,'mid':25,'slow':99,'atrN':14,
    'breakLookback':60,'ema50N':50,'momentumPct':0.01,
    'gainFilterPct':20,'highPosFilterPct':80,
    'stopMul':0.8,'tpMul':5.0,'trailMul':0.9,
    'lockProfitPct':3.0,'lockTrailPct':1.2,
    'maxBars':400,'minBars':200,'leverage':5,
}

def get_k(sym,iv,pages=8):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et: url+=f'&endTime={et}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=15).read().decode())
        except Exception:
            time.sleep(0.3); continue
        if not b: break
        data=b+data; et=str(b[0][0]); time.sleep(0.04)
    data.sort(key=lambda x:x[0])
    return [{'t':int(x[0]),'open':float(x[1]),'high':float(x[2]),'low':float(x[3]),'close':float(x[4]),'volume':float(x[5])} for x in data]

def ema_series(vals,p):
    out=[None]*len(vals)
    if len(vals)<p: return out
    k=2/(p+1); e=sum(vals[:p])/p; out[p-1]=e
    for i in range(p,len(vals)):
        e=vals[i]*k+e*(1-k); out[i]=e
    return out

def atr_at(kl,i,n=14):
    if i<n+1: return 0
    trs=[]
    for j in range(i-n,i+1):
        if j<1: continue
        h=kl[j]['high']; l=kl[j]['low']; pc=kl[j-1]['close']
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs) if trs else 0

def entry_signal(kl,i,opt):
    """复现 entrySignal"""
    if i<opt['minBars']: return None
    closes=[k['close'] for k in kl[:i+1]]
    e7=ema_series(closes,opt['fast'])[i]
    e25=ema_series(closes,opt['mid'])[i]
    e99=ema_series(closes,opt['slow'])[i]
    if e7 is None or e25 is None or e99 is None: return None
    arrange='UP' if (e7>e25>e99) else ('DOWN' if (e7<e25<e99) else 'FLAT')
    if arrange=='FLAT': return None
    price=closes[i]
    # 突破近60根高低
    win=kl[max(0,i-opt['breakLookback']):i]
    if not win: return None
    hi=max(k['high'] for k in win); lo=min(k['low'] for k in win)
    if arrange=='UP' and price<=hi: return None
    if arrange=='DOWN' and price>=lo: return None
    # 相对EMA50偏移>1%
    e50=ema_series(closes,opt['ema50N'])[i]
    if e50 is None: return None
    dev=abs(price-e50)/e50
    if dev<opt['momentumPct']: return None
    # 高位追高过滤: 近20根涨幅>20%不追
    if i>=20:
        c0=kl[i-20]['close']
        gain=(price-c0)/c0*100
        if abs(gain)>opt['gainFilterPct']: return None
    return 'LONG' if arrange=='UP' else 'SHORT'

def backtest(kl,opt):
    pos=None;trades=[];pnl=0.0;L=opt['leverage']
    eq=0;pk=0;dd=0
    for i in range(opt['minBars'],len(kl)):
        k=kl[i];price=k['close']
        atr=atr_at(kl,i,opt['atrN'])
        if atr<=0: continue
        if pos:
            entry=pos['entry'];side=pos['side'];best=pos['_best']
            if side=='LONG':
                if price>best: best=price
                pnlPct=(price-entry)/entry*100
                if pnlPct>=opt['lockProfitPct']:
                    stop=best*(1-opt['lockTrailPct']/100)
                else:
                    trail=best-opt['trailMul']*atr
                    initStop=entry-opt['stopMul']*atr
                    stop=max(initStop,trail)
                tp=entry+opt['tpMul']*atr
                er=None
                if price<=stop: er=f"止损({stop:.4f} pnl={pnlPct:.2f}%)"
                elif price>=tp: er=f"止盈({opt['tpMul']}ATR)"
            else:
                if price<best: best=price
                pnlPct=(entry-price)/entry*100
                if pnlPct>=opt['lockProfitPct']:
                    stop=best*(1+opt['lockTrailPct']/100)
                else:
                    trail=best+opt['trailMul']*atr
                    initStop=entry+opt['stopMul']*atr
                    stop=min(initStop,trail)
                tp=entry-opt['tpMul']*atr
                er=None
                if price>=stop: er=f"止损({stop:.4f} pnl={pnlPct:.2f}%)"
                elif price<=tp: er=f"止盈({opt['tpMul']}ATR)"
            pos['_best']=best
            # 最大持仓bar
            if not er and (i-pos['i'])>=opt['maxBars']: er='超时'
            if er:
                pp=((price-entry)/entry*100) if side=='LONG' else ((entry-price)/entry*100)
                p=pp*L/100.0-FEE*2*L
                pnl+=p;eq+=p;pk=max(pk,eq);dd=max(dd,pk-eq)
                trades.append({'side':side,'pnl':p,'reason':er,'roi':pp*L})
                pos=None
            continue
        sig=entry_signal(kl,i,opt)
        if sig:
            pos={'side':sig,'entry':price,'i':i,'_best':price}
    return trades,pnl,dd

SYMS=['DOGEUSDT','ETHUSDT','SOLUSDT','ADAUSDT','XRPUSDT','DOTUSDT','APTUSDT','LINKUSDT','LTCUSDT','SUIUSDT','AVAXUSDT','INJUSDT']
CACHE="/tmp/bt_4h_cache.json"
if os.path.exists(CACHE):
    D=json.load(open(CACHE)); print(f"缓存: {len(D)}币",flush=True)
else:
    D={}
    for s in SYMS:
        kl=get_k(s,'4h',pages=8)
        if len(kl)>=500: D[s]=kl
        print(f"{s}: {len(kl)}根 4h",flush=True)
    json.dump(D,open(CACHE,"w"))
n=min(len(v) for v in D.values())
print(f"数据: {len(D)}币 x {n}根 4h ({n*4/24:.0f}天 ≈ {n*4/24/365:.1f}年)\n",flush=True)

def run(opt,label):
    T=0;W=0;P=0.0;DD=0;COINS=0
    for sym,kl in D.items():
        tr,p,dd=backtest(kl,opt)
        if not tr: continue
        w=sum(1 for t in tr if t['pnl']>0)
        T+=len(tr);W+=w;P+=p;DD=max(DD,dd)
        if p>0: COINS+=1
    if T: print(f"  {label:24s} {T:4d}笔 胜率{100*W/T:5.1f}% 盈亏{P:+8.2f} 回撤{DD:6.2f} 盈利币{COINS}/{len(D)} 每单{P/T:+.4f}",flush=True)
    return P,T,W

print("═══ 止损参数对比 (4h, 真实币安数据) ═══\n",flush=True)
for sm in [0.8,1.2,1.5,1.8,2.0,2.5,3.0]:
    o=dict(CFG); o['stopMul']=sm
    tag=" ←当前" if sm==0.8 else ("  ←原设计" if sm==2.5 else "")
    run(o,f"stopMul={sm}ATR{tag}")

print("\n═══ 辅助参数扫描 (基于最优止损) ═══\n",flush=True)
o=dict(CFG); o['stopMul']=2.5
for tp in [3.0,5.0,7.0,10.0]:
    oo=dict(o); oo['tpMul']=tp
    run(oo,f"止盈{tp}ATR")
print("",flush=True)
for tr in [0.9,1.5,2.0,2.5]:
    oo=dict(o); oo['trailMul']=tr
    run(oo,f"移动止盈{tr}ATR")
