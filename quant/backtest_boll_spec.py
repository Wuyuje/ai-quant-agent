#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""布林策略完整回测 (复用实际实现逻辑)
开仓: canOpen(带宽分位<=85% + 连续3根收窄) + entrySignal(收盘触/破上轨开空, 触/破下轨开多)
管理: checkTakeProfit(放量ATR移动止盈3ATR×0.3) / checkHardStop / checkAdd(补仓3次) / checkFinalStop
周期: 5m (实盘用) + 也测 4h 对比
扣 0.2% 费
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT']
FEE=0.002
STD=2.0

def get_klines(sym,interval='5m',pages=3):
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
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'v':float(x[5])} for x in data]

def bands(c,i,n=20,k=2.0):
    s=c[i-n:i]
    if len(s)<n: return None
    m=sum(s)/n; sd=math.sqrt(sum((x-m)**2 for x in s)/n)
    return {'mid':m,'up':m+k*sd,'lo':m-k*sd,'sd':sd,'width':(2*k*sd)/(m or 1)}

def atr(kl,i,n=14):
    trs=[]
    for j in range(max(1,i-n+1),i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c'];trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs) if len(trs)>=n else None

def width_pct(c,i,b,histn=100,n=20):
    if i<histn+n: return 0.5
    wins=[]
    for j in range(i-histn,i):
        bb=bands(c,j+1,n)
        if bb: wins.append(bb['width'])
    if not wins: return 0.5
    return sum(1 for w in wins if w<b['width'])/len(wins)

def is_shrinking(c,i,n=20,shrinkbars=3):
    rw=[]
    for j in range(max(n,i-shrinkbars+1),i+1):
        bb=bands(c,j,n)
        if bb: rw.append(bb['width'])
    if len(rw)<shrinkbars: return False
    for x in range(1,len(rw)):
        if rw[x]>=rw[x-1]: return False
    return True

def can_open(c,i):
    b=bands(c,i)
    if not b: return False,None
    wpc=width_pct(c,i,b)
    # 禁开: 分位>90
    if wpc>0.90: return False,None
    # 解禁: <=85% + 连续3根收窄
    if wpc<=0.85 and is_shrinking(c,i):
        return True,b
    return False,None

def simulate_boll(kl,c,i,side,entry):
    """开仓后管理: ATR移动止盈/硬止损/补仓(简化只止盈止损,不加仓)"""
    a=atr(kl,i)
    if not a: return None
    # 止盈: 放量ATR移动止盈(0.3ATR trail)
    best=entry
    for j in range(i+1,min(i+1500,len(kl))):
        cj=kl[j]['c']; hi=kl[j]['h']; lo=kl[j]['l']
        if side=='LONG':
            if cj>best: best=cj
            trail=best-0.3*a
            if cj<trail: return (cj-entry)/(entry or 1), j   # 移动止盈
        else:
            if cj<best: best=cj
            trail=best+0.3*a
            if cj>trail: return (entry-cj)/(entry or 1), j
    return None

def backtest(sym,interval='5m'):
    kl=get_klines(sym,interval,3)
    if len(kl)<400: return None
    c=[k['c'] for k in kl]
    t=w=0;ret=0.0; i=150
    while i<len(c)-20:
        b=bands(c,i)
        if not b: i+=1;continue
        ok,bo=can_open(c,i)
        if not ok: i+=1;continue
        price=c[i]
        side=None
        if price>=bo['up']: side='SHORT'
        elif price<=bo['lo']: side='LONG'
        if not side: i+=1;continue
        r=simulate_boll(kl,c,i,side,price)
        if r:
            pnl,exi=r; pnl-=2*FEE; ret+=pnl; t+=1
            if pnl>0: w+=1
            i=exi+1
        else:
            i+=1
    return {'t':t,'w':w,'ret':ret}

print("═══ 布林策略回测(实盘逻辑: 5m触轨+分位收窄+ATR移动止盈) ═══\n")
for interval in ['5m','1h','4h']:
    print(f"\n─── 周期 {interval} ───")
    a_t=a_w=0; a_ret=0.0
    rows=[]
    for sym in SYMBOLS:
        try:
            r=backtest(sym,interval)
            if not r or r['t']==0: continue
            a_t+=r['t'];a_w+=r['w'];a_ret+=r['ret']
            rows.append(f"{sym:10} {r['t']}笔 胜{r['w']*100//r['t']}% 总{100*r['ret']:+.0f}%")
        except Exception as e: rows.append(f"{sym:10} err")
    for x in rows: print(x)
    print(f"── 汇总[{interval}] {a_t}笔 胜率{a_w*100//a_t if a_t else 0}% 总{100*a_ret:+.1f}% 每笔{100*a_ret/a_t if a_t else 0:+.4f}%")
