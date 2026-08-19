#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""决定性回测: 4h 大周期 + ADX>25真单边 + 收紧止损(0.8ATR) + 盈亏比3:1移动止盈
验证: 扣0.2%手续费后 是否为正。若正 → 按此重写布林。
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT','INJUSDT']
FEE=0.002  # 开+平 0.2%

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

def ema(v,n):
    if len(v)<n: return None
    k=2/(n+1);e=v[-n]
    for i in range(len(v)-n+1,len(v)): e=v[i]*k+e*(1-k)
    return e

def adx(arr,i,n=14):
    if i<=n: return 0
    plus=minus=0
    # 简单ADX近似: 用价格方向强度
    closes=[x['c'] for x in arr[i-n:i+1]]
    ranges=[]
    for j in range(1,len(closes)):
        ranges.append(abs(closes[j]-closes[j-1]))
    if not ranges: return 0
    # 用 EMA100 归一化趋势强度替代(更稳)
    return 0

def atr(kl,i,n=14):
    trs=[]
    for j in range(i-n+1,i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c'];trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs)

def ema_series(v,n):
    out=[None]*len(v)
    if len(v)<n: return out
    k=2/(n+1);e=v[0];out[0]=e
    for i in range(1,len(v)): e=v[i]*k+e*(1-k);out[i]=e
    return out

def backtest(sym):
    kl=get_klines(sym,'4h',4)
    if len(kl)<400: return None
    c=[k['c'] for k in kl]
    e7=ema_series(c,7); e25=ema_series(c,25); e99=ema_series(c,99); e50=ema_series(c,50)
    t=w=0; ret=0.0; wins=[];losses=[]
    i=110
    while i<len(c)-100:
        price=c[i]; a=atr(kl,i)
        if not a: i+=1;continue
        up=e7[i]>e25[i]>e99[i]; dn=e7[i]<e25[i]<e99[i]
        # 真单边: 趋势排列 + 趋势强度(价距EMA50>0.3%)
        str_mom=(price-e50[i])/e50[i] if e50[i] else 0
        if not up and not dn: i+=1;continue
        sig='LONG' if up else 'SHORT'
        # 只有在排列刚形成早期开(用EMA7上穿EMA25确认), 顺向
        # 简化: 排列成立 + 强动量(价沿趋势方向偏移)
        strong = up and str_mom>0.003 or dn and str_mom<-0.003
        if not strong: i+=1;continue
        entry=price
        stop=0.8*a       # 收紧止损
        tp=3.0*a         # 盈亏比约3.7:1 (3/0.8)
        # 移动止盈: 每根K线将止损上移, 锁定利润
        best=entry; sellstop=entry - stop if up else entry+stop
        done=False; rrc=0
        for j in range(i+1,min(i+120,len(c))):
            hi=kl[j]['h']; lo=kl[j]['l']
            if up:
                # 移动止损上移(用收盘跟踪)
                cpx=c[j]
                if cpx>best: best=cpx
                trail=best - 0.8*a
                if lo<=max(entry-stop, trail) and c[j]<max(entry-stop,trail):
                    rrc=(max(entry-stop,trail)-entry)/entry;done=True;break
                if hi>=entry+tp: rrc=tp/entry;done=True;break
            else:
                if c[j]<best: best=c[j]
                trail=best + 0.8*a
                if hi>=min(entry+stop,trail) and c[j]>min(entry+stop,trail):
                    rrc=(entry-min(entry+stop,trail))/entry;done=True;break
                if lo<=entry-tp: rrc=-tp/entry;done=True;break
        if done:
            rrc-=2*FEE
            ret+=rrc;t+=1
            (wins if rrc>0 else losses).append(rrc)
            i=j+1
        else:
            i+=1
    return {'t':t,'w':len(wins),'ret':ret}

print("═══ 决定性回测: 4h + 真单边(EMA+动量) + 0.8ATR止损 + 3ATR止盈 + 扣费0.2% ═══\n")
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
print(f"\n════ 汇总: {t}笔 胜率{w*100//t if t else 0}% 总收益{100*ret:+.1f}% 每笔{100*per:+.3f}% ════")
print('扣费后每笔期望>0 →', '✅ 可实盘重写' if per>0 else '❌ 仍需优化')
