#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""严谨回测 #2: 修复出场数学, 消除逻辑bug
策略: 4h 趋势(EMA7>25>99排列) + 0.8ATR止损 + 3ATR止盈 (固定, 不用移动混淆)
出场规则简洁:
  LONG: 止损=entry-0.8ATR, 止盈=entry+3.0ATR
  SHORT: 止损=entry+0.8ATR, 止盈=entry-3.0ATR
  单笔盈亏 = (成交-入场)/入场 - 2*FEE
对比: A)全排列就开  B)只做盈利方向(严格多头只做多)
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT']
FEE=0.002

def get_klines(sym,interval='4h',pages=4):
    data=[];et=''
    for _ in range(pages):
        url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
        if et: url+=f'&endTime={et}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
        except: break
        if not b: break
        data=b+data;et=str(b[0][0]);time.sleep(0.15)
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'t':x[0]} for x in data]

def ema_series(v,n):
    out=[None]*len(v)
    if len(v)<n: return out
    k=2/(n+1);e=v[0];out[0]=e
    for i in range(1,len(v)): e=v[i]*k+e*(1-k);out[i]=e
    return out

def atr(kl,i,n=14):
    trs=[]
    for j in range(i-n+1,i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c'];trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs)

def simulate(kl, sig, entry, stop, tp, i, maxbars=200):
    """固定止损止盈. 返回 (pnl_pct, exit_idx) 或 (None,None)未触发"""
    for j in range(i+1,min(i+maxbars,len(kl))):
        hi=kl[j]['h']; lo=kl[j]['l']
        if sig=='LONG':
            if lo<=stop: return (stop-entry)/(entry or 1), j
            if hi>=tp:   return (tp-entry)/(entry or 1), j
        else:
            if hi>=stop: return (entry-stop)/(entry or 1), j
            if lo<=tp:   return (entry-tp)/(entry or 1), j
    return None,None

def backtest(sym):
    kl=get_klines(sym,'4h',4)
    if len(kl)<500: return None
    c=[k['c'] for k in kl]
    e7=ema_series(c,7); e25=ema_series(c,25); e99=ema_series(c,99)
    # 方案A全排列, 方案B严格多头/严格空头都做
    resA={'t':0,'w':0,'ret':0.0}
    resB={'t':0,'w':0,'ret':0.0}
    i=110
    while i<len(c)-50:
        a=atr(kl,i)
        if not a: i+=1;continue
        up = e7[i] and e25[i] and e99[i] and (e7[i]>e25[i]>e99[i])
        dn = e7[i] and e25[i] and e99[i] and (e7[i]<e25[i]<e99[i])
        if not up and not dn: i+=1;continue
        entry=c[i]
        # A: 多头排列只做多, 空头排列只做空 (顺势)  [2:1盈亏比 0.8ATR止损/3ATR止盈]
        tps=[3.0, 2.5, 2.0]  # 测三个止盈倍数? 这里用3.0
        sig='LONG' if up else 'SHORT'
        stop = entry - 0.8*a if sig=='LONG' else entry + 0.8*a
        tp   = entry + 3.0*a if sig=='LONG' else entry - 3.0*a
        pnl,exi=simulate(kl,sig,entry,stop,tp,i)
        if pnl is not None:
            pnl-=2*FEE
            resA['t']+=1; resA['ret']+=pnl
            if pnl>0: resA['w']+=1
            i=exi+1
        else:
            i+=1
    return resA

print("═══ 严谨回测: 4h 顺势趋势 + 0.8ATR止损 + 3ATR止盈(盈亏比3.75) + 扣0.2%费 ═══\n")
agg=[0,0,0.0]
for sym in SYMBOLS:
    try:
        r=backtest(sym)
        if not r or r['t']==0: continue
        agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['ret']
        print(f"{sym:10} {r['t']}笔 胜率{r['w']*100//r['t']}% 总{100*r['ret']:+.1f}%")
    except Exception as e: print(sym,'err',str(e)[:20])
t,w,ret=agg
per=ret/t if t else 0
print(f"\n════ 汇总: {t}笔 胜率{w*100//t if t else 0}% 总{100*ret:+.1f}% 每笔{100*per:+.3f}% ════")
print('扣费后>0 →', '✅ 可实盘' if per>0 else '❌ 仍亏')
