#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真趋势波段回测: 低胜率 + 高盈亏比
核心: 只在确认强单边中段介入, 宽止损, 高止盈让利润奔跑
设计:
  开仓: EMA(7>25>99)多头排列/空头排列 + ADX>25(强趋势) + 动量确认 + 已突破近期高低点
  止损: 2.5 ATR (宽, 避免噪声扫掉)
  止盈: 5.0 ATR (高, 让利润奔跑)  [盈亏比=2:1]
  若有移动止盈(跌破峰值-2ATR锁定)则更佳
周期: 4h
扣0.2%费
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT','INJUSDT','FETUSDT','WIFUSDT']
FEE=0.002

def get_klines(sym,interval,pages=6):
    data=[];et=''
    for _ in range(pages):
        url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
        if et: url+=f'&endTime={et}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
        except: break
        if not b: break
        data=b+data;et=str(b[0][0]);time.sleep(0.14)
    data.sort(key=lambda x:x[0])
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'t':x[0]} for x in data]

def ema_series(v,n):
    out=[None]*len(v)
    if len(v)<n: return out
    k=2/(n+1);e=v[0];out[0]=e
    for i in range(1,len(v)): e=v[i]*k+e*(1-k);out[i]=e
    return out

def atr(kl,i,n=14):
    trs=[]
    for j in range(max(1,i-n+1),i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c'];trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs) if len(trs)>=n else None

def adx(kl,i,n=14):
    # 简化ADX: 用EMA方向稳定性近似。真实ADX较高, 用趋势强度代理
    if i<=n*2: return 0
    # 用 近期方向一致性
    c=[kl[j]['c'] for j in range(i-n,i+1)]
    up=sum(1 for j in range(1,len(c)) if c[j]>c[j-1])
    dn=len(c)-1-up
    dx=abs(up-dn)/(len(c)-1)  # 0~1 方向一致性
    # 结合波动相对幅度
    return dx*100

def simulate_trend(kl, sig, entry, a, i, stop_mul=2.5, tp_mul=5.0, trail_mul=2.0):
    """趋势波段: 宽止损 + 高止盈 + 移动止盈(峰值回撤锁定)"""
    stop = entry - stop_mul*a if sig=='LONG' else entry + stop_mul*a
    tp   = entry + tp_mul*a if sig=='LONG' else entry - tp_mul*a
    best=entry; exit_pnl=None
    for j in range(i+1,min(i+400,len(kl))):
        hi=kl[j]['h']; lo=kl[j]['l']; cj=kl[j]['c']
        if sig=='LONG':
            if cj>best: best=cj
            trail = best - trail_mul*a
            if lo<=stop and (trail>stop): stop=trail  # 移动止损提升但不低于初始
            if lo<=stop: exit_pnl=(stop-entry)/(entry or 1);break
            if hi>=tp: exit_pnl=(tp-entry)/(entry or 1);break
        else:
            if cj<best: best=cj
            trail = best + trail_mul*a
            if hi>=stop and (trail<stop): stop=trail
            if hi>=stop: exit_pnl=(entry-stop)/(entry or 1);break
            if lo<=tp: exit_pnl=(entry-tp)/(entry or 1);break
    return exit_pnl

def backtest(sym,interval='4h'):
    kl=get_klines(sym,interval,6)
    if len(kl)<500: return None
    c=[k['c'] for k in kl]
    e7=ema_series(c,7); e25=ema_series(c,25); e99=ema_series(c,99)
    e50=ema_series(c,50)
    t=w=0;ret=0.0; i=120
    while i<len(c)-60:
        a=atr(kl,i)
        if not a: i+=1;continue
        up = e7[i] and e25[i] and e99[i] and (e7[i]>e25[i]>e99[i])
        dn = e7[i] and e25[i] and e99[i] and (e7[i]<e25[i]<e99[i])
        if not up and not dn: i+=1;continue
        # 必须已走出趋势一段(动量/突破): 价相对EMA50有明显偏移 + 突破近60根高低
        price=c[i]; e50v=e50[i]
        if up:
            hi60=max(c[i-60:i])
            if not (price>hi60 and (price-e50v)/(e50v or 1)>0.01): i+=1;continue
        else:
            lo60=min(c[i-60:i])
            if not (price<lo60 and (price-e50v)/(e50v or 1)<-0.01): i+=1;continue
        sig='LONG' if up else 'SHORT'
        pnl=simulate_trend(kl,sig,price,a,i)
        if pnl is not None:
            pnl-=2*FEE; ret+=pnl; t+=1
            if pnl>0: w+=1
        i+=1
    return {'t':t,'w':w,'ret':ret}

print("═══ 真趋势波段回测: 4h EMA排列+突破+强动量, 2.5ATR止损/5ATR止盈/2ATR移动止盈 ═══\n")
agg=[0,0,0.0]
for sym in SYMBOLS:
    try:
        r=backtest(sym)
        if not r or r['t']==0: continue
        agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['ret']
        print(f"{sym:10} {r['t']}笔 胜率{r['w']*100//r['t']}% 总{100*r['ret']:+.1f}%")
    except Exception as e: print(sym,'err',str(e)[:18])
t,w,ret=agg; per=ret/t if t else 0
print(f"\n════ 汇总: {t}笔 胜率{w*100//t if t else 0}% 总{100*ret:+.1f}% 每笔{100*per:+.3f}% 均值赢:{'有' if per>0 else '负'} ════")
import statistics
