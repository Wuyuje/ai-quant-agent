#!/usr/bin/env python3
"""SuperTrend反转策略增强优化 - 提升胜率+回报
基础: SUPER(10,3)触上轨做空/触下轨做多(反转)
增强维度:
  A. 大周期趋势过滤: SUPER大周期方向与反转方向一致才做(顺势反转)
  B. 时间出场: 持仓超N根K线强制平仓(防反向被套)
  C. 止损: 反向SUPER翻转平仓 + 可选ATR硬止损
周期: 5m, 多币池
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
    hl2=[(h[i]+l[i])/2 for i in range(n)]
    up=[0.0]*n;dn=[0.0]*n;dirn=[1]*n
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

def run(kl,p,m,bigP,timeExit,atrStop):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);dirn=supertrend_dir(h,l,c,p,m)
    bigdir=supertrend_dir(h,l,c,bigP,m) if bigP else None
    atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]));atr[i]=(atr[i-1]*13+tr)/14 if i>=14 else tr
    trades=[];pos=0;entry=0;ei=0
    for i in range(1,n):
        # 反转信号: 触上轨(红线,dirn=1)做空; 触下轨(绿线,dirn=-1)做多
        sig=-dirn[i] if dirn[i]!=dirn[i-1] else 0  # 仅在翻转点发信号(避免重复)
        # 大周期趋势过滤: 只允许顺势反转
        if sig!=0 and bigdir is not None:
            if bigdir[i]==1 and sig!=1: sig=0        # 大周期上行, 只做多反转
            elif bigdir[i]==-1 and sig!=-1: sig=0    # 大周期下行, 只做空反转
        if sig!=0:
            if pos!=0:
                pnl=((c[i]-entry)/entry*100)*pos;trades.append(pnl);pos=0
            if timeExit and (i-ei)>=timeExit and pos!=0:
                pnl=((c[i]-entry)/entry*100)*pos;trades.append(pnl);pos=0
            pos=sig;entry=c[i];ei=i
        elif pos!=0:
            # 持仓中: 时间出场 / ATR止损
            closed=False
            if timeExit and (i-ei)>=timeExit:
                pnl=((c[i]-entry)/entry*100)*pos;trades.append(pnl);pos=0;closed=True
            elif atrStop and atr[i]>0:
                if pos==1 and l[i]<=entry-atrStop*atr[i]:
                    pnl=((entry-atrStop*atr[i]-entry)/entry)*100;trades.append(pnl);pos=0;closed=True
                elif pos==-1 and h[i]>=entry+atrStop*atr[i]:
                    pnl=((entry+atrStop*atr[i]-entry)/entry)*100;trades.append(pnl);pos=0;closed=True
            if not closed and pos!=0 and timeExit is None and atrStop is None:
                # 无增强: 由下一次翻转信号平仓(见上方)
                pass
    if pos!=0:
        pnl=((c[-1]-entry)/entry*100)*pos;trades.append(pnl)
    if len(trades)<10:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT']
configs=[
    (10,3,0,0,0,'基础ST10/3'),
    (10,3,30,0,0,'+30周期大趋势过滤'),
    (10,3,30,8,0,'+大趋势+8根时间出场'),
    (10,3,0,10,0,'+10根时间出场'),
    (10,3,30,10,2.0,'+大趋势+10根+2ATR硬止损'),
    (7,3,30,8,1.5,'ST7/3优化组合'),
    (10,2.5,30,8,1.5,'ST10/2.5组合'),
]
print(f"{'币':<10}{'配置':<26}{'胜率':>7}{'样本':>5}{'净盈亏%':>9}",flush=True)
for sym in POOL:
    kl=fetch(sym,'5m',3000)
    for (p,m,bigP,te,ast,lab) in configs:
        r=run(kl,p,m,bigP,te,ast)
        if r:
            print(f"  {sym:<8}{lab:<24}{r['acc']:6.1f}%  {r['n']:>4}  {r['net']:8.2f}",flush=True)
        else: print(f"  {sym:<8}{lab:<24} 样本不足",flush=True)
