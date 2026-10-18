#!/usr/bin/env python3
"""趋势策略(MA7)回测 — 精确复现 lib/trend-strategy.js
开仓: EMA20/60排列 + EMA间距<1.5% + ADX 20-50 + RSI过滤(多<50/空>50) + 15m确认
止盈: 浮盈≥3%后峰值回撤1.5%锁利(移动止盈)
止损: 12 ATR / 单K 6% / 终极 15% / 总浮亏20% / 反向15% / 时间4h
周期: 5m, 15m确认
"""
import json, math, os, sys, urllib.request, time
sys.stdout.reconfigure(line_buffering=True)

UA={'User-Agent':'Mozilla/5.0'}; FEE=0.0004

CFG = {
    'interval':'5m', 'htf':'15m',
    'bbPeriod':20,'bbStd':2.0,'atrPeriod':14,'minAtrPct':0.10,
    'profitTriggerPct':3.0,'trailDrawdownPct':1.5,
    'totalLossPct':20,'reverseTriggerPct':15,'fullStopPct':20,
    'atrStopMultiplier':12,'singleKLossPct':6,'ultimateLossPct':15,
    'consecutiveLossPct':2.5,'consecutiveLossKlines':10,
    'maxHoldHours':4,'maxHoldLossPct':5,'avgPriceLossPct':8,
    'emaGapMax':1.5,'adxMin':20,'adxMax':50,'leverage':3,
    'blacklist':['BANKUSDT','BTCUSDT','BNBUSDT'],
}

def get_k(sym, iv, pages=8):
    data=[]; et=''
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

def ema(kl,p):
    if len(kl)<p: return None
    k=2/(p+1); e=sum(x['close'] for x in kl[:p])/p
    for x in kl[p:]: e=x['close']*k+e*(1-k)
    return e

def ema_series(kl,p):
    """返回每个位置的EMA(供HTF对齐)"""
    out=[None]*len(kl)
    if len(kl)<p: return out
    k=2/(p+1); e=sum(x['close'] for x in kl[:p])/p; out[p-1]=e
    for i in range(p,len(kl)):
        e=kl[i]['close']*k+e*(1-k); out[i]=e
    return out

def atr_calc(kl,p=14):
    n=len(kl); out=[0.0]*n
    for i in range(n):
        if i==0: out[i]=kl[i]['high']-kl[i]['low']; continue
        tr=max(kl[i]['high']-kl[i]['low'],abs(kl[i]['high']-kl[i-1]['close']),abs(kl[i]['low']-kl[i-1]['close']))
        out[i]=tr if i<p else (out[i-1]*(p-1)+tr)/p
    return out

def adx_calc(kl,p=14):
    n=len(kl)
    if n<p+2: return [None]*n
    plus=[0.0]*n;minus=[0.0]*n;tr=[0.0]*n
    for i in range(1,n):
        up=kl[i]['high']-kl[i-1]['high']; dn=kl[i-1]['low']-kl[i]['low']
        plus[i]=up if (up>dn and up>0) else 0.0
        minus[i]=dn if (dn>up and dn>0) else 0.0
        tr[i]=max(kl[i]['high']-kl[i]['low'],abs(kl[i]['high']-kl[i-1]['close']),abs(kl[i]['low']-kl[i-1]['close']))
    out=[None]*n;pdm=mdm=atr=0.0
    for i in range(1,n):
        if i<=p:
            pdm+=plus[i];mdm+=minus[i];atr+=tr[i]
            if i==p:
                pdi=100*pdm/atr if atr else 0;mdi=100*mdm/atr if atr else 0
                out[i]=100*abs(pdi-mdi)/max(pdi+mdi,1e-9)
        else:
            pdm=pdm-pdm/p+plus[i];mdm=mdm-mdm/p+minus[i];atr=atr-atr/p+tr[i]
            pdi=100*pdm/atr if atr else 0;mdi=100*mdm/atr if atr else 0
            out[i]=100*abs(pdi-mdi)/max(pdi+mdi,1e-9)
    return out

def rsi_calc(kl,p=14):
    n=len(kl)
    if n<p+1: return [None]*n
    out=[None]*n; g=0.0; l=0.0
    for i in range(1,p+1):
        d=kl[i]['close']-kl[i-1]['close']
        if d>0: g+=d
        else: l-=d
    ag=g/p; al=l/p
    out[p]=100-100/(1+ag/max(al,1e-9))
    for i in range(p+1,n):
        d=kl[i]['close']-kl[i-1]['close']
        ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/max(al,1e-9))
    return out

def backtest(kl5, kl15, opt):
    n=len(kl5)
    e20=ema_series(kl5,20); e60=ema_series(kl5,60)
    atr=atr_calc(kl5,opt['atrPeriod']); adx=adx_calc(kl5,14); rsi=rsi_calc(kl5,14)
    h20=ema_series(kl15,20); h60=ema_series(kl15,60)
    hmap={k['t']:i for i,k in enumerate(kl15)}
    pos=None; trades=[]; pnl=0.0; L=opt['leverage']
    eq=0;pk=0;dd=0; last_close_t=0
    for i in range(70,n):
        k=kl5[i]; price=k['close']; a=atr[i]; ad=adx[i]; r=rsi[i]
        if not a or ad is None or r is None: continue
        # 离场
        if pos:
            e=pos['entry']; side=pos['side']
            pp=((price-e)/e*100) if side=='LONG' else ((e-price)/e*100)
            roi=pp*L; h=(k['t']-pos['time'])/3600000; er=None
            # 移动止盈
            if pp>=opt['profitTriggerPct']:
                if not pos.get('peak') or pp>pos['peak']: pos['peak']=pp
                if pos['peak']>opt['profitTriggerPct'] and (pos['peak']-pp)>=opt['trailDrawdownPct']:
                    er='移动止盈'
            # ATR止损(宽)
            if not er:
                if side=='LONG' and price<=e-opt['atrStopMultiplier']*a: er='SL_ATR'
                elif side=='SHORT' and price>=e+opt['atrStopMultiplier']*a: er='SL_ATR'
            # 单K
            chg=abs((k['close']-k['open'])/k['open']*100)
            if not er and chg>=opt['singleKLossPct'] and pp<0: er='SL_单K'
            # 总浮亏
            if not er and roi<=-opt['totalLossPct']: er='SL_总浮亏'
            # 反向
            if not er and roi<=-opt['reverseTriggerPct']: er='REV_反向'
            # 时间
            if not er and h>=opt['maxHoldHours'] and roi<=-opt['maxHoldLossPct']: er='TIME'
            if er:
                p=pp*L/100.0-FEE*2*L
                pnl+=p;eq+=p;pk=max(pk,eq);dd=max(dd,pk-eq)
                trades.append({'side':side,'pnl':p,'reason':er,'roi':roi})
                pos=None
            continue
        # 开仓
        if a/price*100 < opt['minAtrPct']: continue
        if not e20[i] or not e60[i]: continue
        up=e20[i]>e60[i]; dn=e20[i]<e60[i]
        gap=abs(e20[i]-e60[i])/e60[i]*100
        if gap>=opt['emaGapMax']: continue
        if ad<opt['adxMin'] or ad>opt['adxMax']: continue
        if up and r>=50: continue
        if dn and r<=50: continue
        # 15m确认
        idx=hmap.get(k['t'])
        if idx is None or idx<60: continue
        if not h20[idx] or not h60[idx]: continue
        if up and h20[idx]<=h60[idx]: continue
        if dn and h20[idx]>=h60[idx]: continue
        if up: pos={'side':'LONG','entry':price,'time':k['t']}
        elif dn: pos={'side':'SHORT','entry':price,'time':k['t']}
    return trades,pnl,dd

SYMS=['DOGEUSDT','ETHUSDT','SOLUSDT','ADAUSDT','XRPUSDT','DOTUSDT','APTUSDT','LINKUSDT','LTCUSDT','SUIUSDT','AVAXUSDT','INJUSDT']
CACHE="/tmp/bt_trend_cache.json"
if os.path.exists(CACHE):
    C=json.load(open(CACHE)); print(f"缓存: {len(C)}币", flush=True)
else:
    C={}
    for s in SYMS:
        k5=get_k(s,'5m',pages=10); k15=get_k(s,'15m',pages=4)
        if len(k5)>=500 and len(k15)>=100: C[s]={'k5':k5,'k15':k15}
        print(f"{s}: 5m={len(k5)} 15m={len(k15)}", flush=True)
    json.dump(C,open(CACHE,"w"))

opt=dict(CFG); opt.pop('blacklist')
print(f"\n═══ 趋势策略回测 (5m周期 + 15m确认, {len(C)}币) ═══\n", flush=True)
T=0;W=0;P=0.0;DD=0;coins=0;rs={};sd={}
for sym,d in C.items():
    if sym in CFG['blacklist']: continue
    tr,p,dd=backtest(d['k5'],d['k15'],opt)
    if not tr: continue
    w=sum(1 for t in tr if t['pnl']>0)
    T+=len(tr);W+=w;P+=p;DD=max(DD,dd)
    if p>0: coins+=1
    for t in tr:
        rs[t['reason']]=rs.get(t['reason'],0)+t['pnl']
        sd[t['side']]=sd.get(t['side'],[0,0]); sd[t['side']][0]+=1
        if t['pnl']>0: sd[t['side']][1]+=1
    print(f"  {sym:10s} {len(tr):3d}笔 胜率{100*w/len(tr):5.1f}% 盈亏{p:+7.2f} 回撤{dd:.2f}", flush=True)
print(f"\n═══ 汇总 ═══", flush=True)
print(f"  {T}笔 胜率{100*W/max(1,T):.1f}% ({W}胜/{T-W}负)", flush=True)
print(f"  总盈亏: {P:+.2f}  最大回撤: {DD:.2f}  每单期望: {P/max(1,T):+.5f}", flush=True)
print(f"  盈利币: {coins}/{len(C)}", flush=True)
print(f"\n离场原因:", flush=True)
for r in sorted(rs,key=lambda x:rs[x]): print(f"  {r:12s} {rs[r]:+.2f}", flush=True)
print(f"\n方向:", flush=True)
for s in sd: print(f"  {s:6s} {sd[s][0]}笔 胜率{100*sd[s][1]/sd[s][0]:.1f}%", flush=True)
gains=[t for t in []] 
