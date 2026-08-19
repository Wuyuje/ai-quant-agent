#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""布林触轨就开, 1h, 盈亏比2:1 ATR止损, 扣手续费验证"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT','INJUSDT']

def get_klines(sym,interval='1h',pages=3):
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

def bolls(c,i,n=20,k=2.0):
    s=c[i-n:i]
    if len(s)<n: return None
    m=sum(s)/n;sd=math.sqrt(sum((x-m)**2 for x in s)/n)
    return {'mid':m,'up':m+k*sd,'lo':m-k*sd,'sd':sd}

def atr(kl,i,n=14):
    trs=[]
    for j in range(i-n+1,i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c'];trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs)

FEE=0.001  # taker 0.1% (开+平≈0.2%)
print('=== 布林触轨就开, 1h, 盈亏比2:1(1.5ATR止损/3ATR止盈), 扣0.2%手续费 ===')
agg=[0,0,0.0]
for sym in SYMBOLS:
    try:
        kl=get_klines(sym)
        c=[k['c'] for k in kl]
        if len(c)<500: continue
        t=w=0; ret=0.0
        i=121
        while i<len(c)-100:
            b=bolls(c,i)
            if not b: i+=1;continue
            price=c[i];a=atr(kl,i)
            sig='SHORT' if price>=b['up'] else ('LONG' if price<=b['lo'] else None)
            if not sig or not a: i+=1; continue
            entry=price;sd1=1.5*a;tp1=3.0*a
            done=False; rrc=0.0
            for j in range(i+1,min(i+100,len(c))):
                hi=kl[j]['h'];lo=kl[j]['l']
                if sig=='LONG':
                    if lo<=entry-sd1: rrc=-sd1/entry;done=True;break
                    if hi>=entry+tp1: rrc=tp1/entry;done=True;break
                else:
                    if hi>=entry+sd1: rrc=-sd1/entry;done=True;break
                    if lo<=entry-tp1: rrc=tp1/entry;done=True;break
            if done:
                rrc-=2*FEE
                ret+=rrc;t+=1
                if rrc>0: w+=1
                i=j+1
            else:
                i+=1
        agg[0]+=t;agg[1]+=w;agg[2]+=ret
        print(f'{sym:10} {t}笔 胜率{w*100//t if t else 0}% 总ret{ret*100:+.1f}%')
    except Exception as e: print(sym,'err',str(e)[:20])
t,w,ret=agg
print(f'\n════ 汇总: {t}笔 胜率{w*100//t if t else 0}% 总收益{ret*100:+.1f}% 每笔{ret/t*100 if t else 0:+.3f}% ════')
print('每笔期望>0(扣手续费) →', '✅ 可实盘' if (ret/t if t else 0)>0 else '❌ 仍亏(需优化)')
