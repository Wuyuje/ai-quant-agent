#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""布林 反方向开仓 专项回测
反向均值回归: 触上轨做多(做回归中轨), 触下轨做空(做回归中轨)
对比不同起始入场+出场组合, 找正期望:
  出场方案A: 止盈=回中轨, 止损=固定xATR(往轨道外)
  出场方案B: 止盈=固定yATR(回不到中轨也行), 止损=固定xATR
周期: 5m / 1h / 4h
扣0.2%手续费
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT','INJUSDT']
FEE=0.002

def get_klines(sym,interval,pages=3):
    data=[];et=''
    for _ in range(pages):
        url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
        if et: url+=f'&endTime={et}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
        except: break
        if not b: break
        data=b+data;et=str(b[0][0]);time.sleep(0.13)
    data.sort(key=lambda x:x[0])
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'t':x[0]} for x in data]

def bands(c,i,n=20,k=2.0):
    s=c[i-n:i]
    if len(s)<n: return None
    m=sum(s)/n; sd=math.sqrt(sum((x-m)**2 for x in s)/n)
    return {'mid':m,'up':m+k*sd,'lo':m-k*sd,'sd':sd}

def atr(kl,i,n=14):
    trs=[]
    for j in range(max(1,i-n+1),i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c'];trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs) if len(trs)>=n else None

def backtest(sym,interval,tp_mode,stop_mul,tp_mul):
    """反方向均值回归
    tp_mode='mid': 止盈=回归中轨;  'fix': 止盈=tp_mul*ATR
    开仓: 触上轨→LONG(回落), 触下轨→SHORT(反弹)
    """
    kl=get_klines(sym,interval)
    if not kl or len(kl)<300: return None
    c=[k['c'] for k in kl]
    t=w=0;ret=0.0; i=40
    while i<len(c)-30:
        b=bands(c,i); a=atr(kl,i)
        if not b or not a: i+=1;continue
        price=c[i]
        if price>=b['up']: sig='LONG'; refline=b['mid']
        elif price<=b['lo']: sig='SHORT'; refline=b['mid']
        else: i+=1;continue
        # 出场
        if tp_mode=='mid':
            tp=refline
            stop=price+stop_mul*a if sig=='LONG' else price-stop_mul*a
        else:
            tp=price+tp_mul*a if sig=='LONG' else price-tp_mul*a
            stop=price+stop_mul*a if sig=='LONG' else price-stop_mul*a
        carried=False; pnl=0
        for j in range(i+1,min(i+300,len(kl))):
            hi=kl[j]['h'];lo=kl[j]['l']
            if sig=='LONG':
                if tp_mode=='mid' and lo<=tp: pnl=(tp-price)/(price or 1); carried=True;break
                if tp_mode=='fix' and hi>=tp: pnl=(tp-price)/(price or 1); carried=True;break
                if hi>=stop: pnl=(stop-price)/(price or 1); carried=True;break
            else:
                if tp_mode=='mid' and hi>=tp: pnl=(price-tp)/(price or 1); carried=True;break
                if tp_mode=='fix' and lo<=tp: pnl=(price-tp)/(price or 1); carried=True;break
                if lo<=stop: pnl=(price-stop)/(price or 1); carried=True;break
        if carried:
            pnl-=2*FEE;ret+=pnl;t+=1
            if pnl>0:w+=1
        i+=1
    return {'t':t,'w':w,'ret':ret}

print("═══ 布林反方向(均值回归) 专项回测 ═══\n")
for interval in ['5m','1h','4h']:
    print(f"\n─── 周期 {interval} ───")
    combos=[]
    # A: 止盈回中轨
    for sm in [1.0,1.5,2.0,2.5,3.0]:
        agg=[0,0,0.0]
        for sym in SYMBOLS:
            try:
                r=backtest(sym,interval,'mid',sm,0)
                if r and r['t']: agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['ret']
            except: pass
        if agg[0]:
            per=agg[2]/agg[0]; wr=agg[1]*100/agg[0]
            combos.append((f'A:回中轨/损{sm}ATR',wr,per,agg[0],agg[2]))
    # B: 固定止盈+固定止损
    for sm in [1.5,2.0]:
        for tm in [0.8,1.0,1.5]:
            agg=[0,0,0.0]
            for sym in SYMBOLS:
                try:
                    r=backtest(sym,interval,'fix',sm,tm)
                    if r and r['t']: agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['ret']
                except: pass
            if agg[0]:
                per=agg[2]/agg[0];wr=agg[1]*100/agg[0]
                combos.append((f'B:盈{tm}ATR/损{sm}ATR',wr,per,agg[0],agg[2]))
    # 排序显示(按每笔)
    combos.sort(key=lambda x:-x[2])
    print(f"{'组合':28} {'胜率':>6} {'每笔%':>8} {'笔数':>5} {'总%':>8}")
    for name,wr,per,cnt,tr in combos:
        flag='✅' if per>0 else ''
        print(f"{name:28} {wr:5.1f}% {100*per:+7.3f}% {cnt:5d} {100*tr:+7.1f}% {flag}")