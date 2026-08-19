#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""4h布林反向(均值回归)参数扫描
反向: 触上轨开LONG(做回中轨), 触下轨开SHORT(做回中轨) — 均值回归
扫描止盈止损组合, 找能转正期望的参数
关键问题: 均值回归应该 止盈=回中轨(赚小) 止损=继续突破(亏大)? 这是反的要小心
均值回归赚的是"回归中轨"的确定性, 盈亏比通常<1但胜率高
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
        data=b+data;et=str(b[0][0]);time.sleep(0.14)
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'t':x[0]} for x in data]

def bolls(c,i,n=20,k=2.0):
    s=c[i-n:i]
    if len(s)<n: return None
    m=sum(s)/n; sd=math.sqrt(sum((x-m)**2 for x in s)/n)
    return {'mid':m,'up':m+k*sd,'lo':m-k*sd,'sd':sd}

def atr(kl,i,n=14):
    trs=[]
    for j in range(i-n+1,i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c'];trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs)

def backtest(sym, stop_mul, tp_type='mid'):
    """均值回归: 
    stop_mul: 止损=stop_mul*ATR (往轨道外走)
    tp_type: 'mid'止盈=回中轨; 'fixed'固定tp_mul*ATR
    """
    kl=get_klines(sym,'4h',4)
    if len(kl)<300: return None
    c=[k['c'] for k in kl]
    t=w=0; ret=0.0; i=40
    while i<len(c)-30:
        b=bolls(c,i); a=atr(kl,i)
        if not b or not a: i+=1;continue
        price=c[i]
        # 反向(均值回归): 触上轨开LONG(回落), 触下轨开SHORT(回升)
        if price>=b['up']: sig='LONG'; refline=b['mid']; stop=price+stop_mul*a; tp=refline
        elif price<=b['lo']: sig='SHORT'; refline=b['mid']; stop=price-stop_mul*a; tp=refline
        else: sig=None; i+=1;continue
        # 等回归中轨或止损
        carried=False
        for j in range(i+1,min(i+200,len(kl))):
            hi=kl[j]['h']; lo=kl[j]['l']; cj=kl[j]['c']
            if sig=='LONG':
                if lo<=tp: pnl=(tp-price)/(price or 1);exit_idx=j;carried=True;break   # 回归中轨止盈
                if hi>=stop: pnl=(stop-price)/(price or 1);exit_idx=j;carried=True;break # 突破止损
            else:
                if hi>=tp: pnl=(price-tp)/(price or 1);exit_idx=j;carried=True;break     # 回归中轨
                if lo<=stop: pnl=(price-stop)/(price or 1);exit_idx=j;carried=True;break # 突破止损
        if carried:
            pnl-=2*FEE; ret+=pnl; t+=1
            if pnl>0: w+=1
            i=exit_idx+1
        else:
            i+=1
    return {'t':t,'w':w,'ret':ret}

# 扫描 stop_mul (均值回归止损宽度, 太小易被扫, 太大风险)
print("═══ 4h布林反向(均值回归)参数扫描: 止损宽度/中轨止盈 ═══\n")
print("stop_mul | 平均胜率 | 平均总retern/币 | 正ret币数 | 每笔期望")
for sm in [0.6,1.0,1.5,2.0,2.5,3.0]:
    t_ts=t_w=0; t_ret=0.0; pos=0
    for sym in SYMBOLS:
        try:
            r=backtest(sym,sm,'mid')
            if not r or r['t']==0: continue
            t_ts+=r['t'];t_w+=r['w'];t_ret+=r['ret']
            if r['ret']>0: pos+=1
        except: pass
    wr=t_w*100/t_ts if t_ts else 0
    per=t_ret/t_ts if t_ts else 0
    print(f"  {sm:.1f}xATR | {wr:5.1f}% | {100*t_ret/len(SYMBOLS):+7.1f}% | {pos:2}/{len(SYMBOLS)} | {100*per:+.4f}%")
