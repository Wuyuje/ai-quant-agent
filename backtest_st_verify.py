#!/usr/bin/env python3
"""SuperTrend反转 严谨核对回测
对比两种实现, 验证70%胜率是否可靠:
IMP1: 仅翻转点发信号+翻转才平仓(可能虚高)
IMP2: 逐K线真实判定持仓, 每次翻转发信号, 反转信号时平仓(更真实)
目标: 确认胜率真实性
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='5m',limit=3000):
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
def supertrend_dir(h,l,c,period,mult):
    n=len(c);atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]))
        atr[i]=(atr[i-1]*(period-1)+tr)/period if i>=period else (atr[i-1]+tr)/i if i<=period else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)];up=[0.0]*n;dn=[0.0]*n;dirn=[1]*n
    for i in range(n):
        upper=hl2[i]+mult*atr[i];lower=hl2[i]-mult*atr[i]
        if i>0:
            upper=upper if (upper<up[i-1] or c[i-1]>up[i-1]) else up[i-1]
            lower=lower if (lower>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
        up[i]=upper;dn[i]=lower
    for i in range(1,n):
        if c[i]>up[i-1]:dirn[i]=1
        elif c[i]<dn[i-1]:dirn[i]=-1
        elif dirn[i-1]==1:dirn[i]=1 if c[i]>=dn[i] else -1
        else:dirn[i]=-1 if c[i]<=up[i] else 1
    return dirn

def run_imp1(kl,p,m):
    """IMP1: 仅翻转发信号, 反转平仓 (原实现)"""
    h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    dirn=supertrend_dir(h,l,c,p,m);n=len(c)
    trades=[];pos=0;entry=0
    for i in range(1,n):
        if dirn[i]!=dirn[i-1]:  # 翻转点
            sig=-dirn[i]
            if sig!=pos:
                if pos!=0:
                    pnl=((c[i]-entry)/entry*100)*pos;trades.append(pnl)
                pos=sig;entry=c[i]
    if pos!=0:
        pnl=((c[-1]-entry)/entry*100)*pos;trades.append(pnl)
    return trades

def run_imp2(kl,p,m):
    """IMP2: 逐K判定. 反转向开仓; 持仓中每K若反向翻转则平(下一单), 否则持有"""
    h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    dirn=supertrend_dir(h,l,c,p,m);n=len(c)
    trades=[];pos=0;entry=0
    for i in range(1,n):
        if dirn[i]!=dirn[i-1]:
            sig=-dirn[i]   # 反转向开仓信号
            # 若已有反向持仓, 平掉
            if pos!=0 and sig!=pos:
                pnl=((c[i]-entry)/entry*100)*pos;trades.append(pnl);pos=0
            if pos==0:
                pos=sig;entry=c[i]
    if pos!=0:
        pnl=((c[-1]-entry)/entry*100)*pos;trades.append(pnl)
    return trades

def stats(trades):
    if len(trades)<8:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
POOL=['BTCUSDT','ETHUSDT','DOGEUSDT','XRPUSDT','SOLUSDT']
print(f"{'币':<10}{'实现':<8}{'胜率':>7}{'样本':>5}{'净盈亏%':>9}",flush=True)
for sym in POOL:
    kl=fetch(sym,'5m',3000)
    t1=run_imp1(kl,10,3);t2=run_imp2(kl,10,3)
    s1=stats(t1);s2=stats(t2)
    if s1: print(f"  {sym:<8}IMP1  {s1['acc']:6.1f}%  {s1['n']:>4}  {s1['net']:8.2f}",flush=True)
    if s2: print(f"  {sym:<8}IMP2  {s2['acc']:6.1f}%  {s2['n']:>4}  {s2['net']:8.2f}",flush=True)
    if not s1 and not s2: print(f"  {sym:<8}样本不足",flush=True)
