#!/usr/bin/env python3
"""SuperTrend 反转(震荡)策略 1分钟 - 参数+出场 综合回测
入场: SuperTrend(period,mult) 触上轨做空/触下轨做多 (反转)
出场: 反向SuperTrend翻转 (基础) + 可选固定ATR止盈/止损
目标: 多币池验证, 找胜率高+盈利的配置
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='5m',limit=1500):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.35);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.9)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in all_k]

def supertrend(h,l,c,period,mult):
    n=len(c)
    # ATR
    atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]))
        atr[i]=(atr[i-1]*(period-1)+tr)/period if i>=period else (atr[i-1]+tr)/i if atr[i-1]>0 and i<=period else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)]
    up=[0.0]*n;dn=[0.0]*n;dirn=[1]*n
    # basic
    for i in range(n):
        upper=hl2[i]+mult*atr[i];lower=hl2[i]-mult*atr[i]
        if i>0:
            upper=upper if (upper<up[i-1] or c[i-1]>up[i-1]) else up[i-1]
            lower=lower if (lower>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
        up[i]=upper;dn[i]=lower
    for i in range(1,n):
        if c[i]>up[i-1] and c[i-1]<=up[i-1]:dirn[i]=1
        elif c[i]<dn[i-1] and c[i-1]>=dn[i-1]:dirn[i]=-1
        elif dirn[i-1]==1:
            dirn[i]=1 if c[i]>=dn[i] else -1
        else:
            dirn[i]=-1 if c[i]<=up[i] else 1
    return dirn

def run(kl,period,mult,tp_atr,sl_atr):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);dirn=supertrend(h,l,c,period,mult)
    # ATR for stop
    atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]));atr[i]=(atr[i-1]*13+tr)/14 if i>=14 else tr
    trades=[];pos=0;entry=0;ei=0
    for i in range(1,n):
        sig=-1 if dirn[i]==1 else 1   # 反转: 上轨→做空, 下轨→做多
        if sig!=pos:
            if pos!=0:
                pnl=((c[i]-entry)/entry*100)*pos;trades.append((pos,pnl,'f'))
            pos=sig;entry=c[i];ei=i
            # 立即测止盈/止损
            continue
        # 持仓中: 查止盈止损
        if pos!=0:
            a=atr[i] if atr[i]>0 else c[i]*0.0005
            if pos==1:
                if h[i]>=entry+tp_atr*a: pnl=((entry+tp_atr*a-entry)/entry)*100*pos;trades.append((pos,pnl,'t'));pos=0
                elif l[i]<=entry-sl_atr*a: pnl=((entry-sl_atr*a-entry)/entry)*100*pos;trades.append((pos,pnl,'s'));pos=0
            else:
                if l[i]<=entry-tp_atr*a: pnl=((entry-tp_atr*a-entry)/entry)*100*pos;trades.append((pos,pnl,'t'));pos=0
                elif h[i]>=entry+sl_atr*a: pnl=((entry+sl_atr*a-entry)/entry)*100*pos;trades.append((pos,pnl,'s'));pos=0
    if pos!=0:
        pnl=((c[-1]-entry)/entry*100)*pos;trades.append((pos,pnl,'f'))
    if len(trades)<10:return None
    wins=[x for x in trades if x[1]>0]
    acc=len(wins)/len(trades)*100;net=sum(x[1] for x in trades)
    return {'acc':acc,'n':len(trades),'net':net,'w':len(wins)}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT']
# 参数扫描
print(f"{'币':<10}{'参数':<14}{'胜率':>7}{'样本':>5}{'净盈亏%':>9}",flush=True)
for sym in POOL:
    kl=fetch(sym,'1m',2000)
    for (p,m,tp,sl,lab) in [(10,3,1.2,1.2,'ST10/3'),(10,3,2.0,1.2,'ST10/3 TP2/SL1.2'),(7,2.5,1.5,1.0,'ST7/2.5'),(10,4,2.0,1.2,'ST10/4')]:
        r=run(kl,p,m,tp,sl) if False else run(kl,p,m,tp,sl)
        if r:
            print(f"  {sym:<8}{lab:<12}{r['acc']:6.1f}%  {r['n']:>4}  {r['net']:8.2f}",flush=True)
        else: print(f"  {sym:<8}{lab:<12} 样本不足",flush=True)
