#!/usr/bin/env python3
"""SuperTrend(超级趋势线) 1分钟级别 回测
思路A: SuperTrend 趋势跟随 - 上轨→做多, 下轨→做空
思路B: SuperTrend 反转(震荡) - 触上轨做空/触下轨做多(均值回归)
周期: 1m
核心指标: SuperTrend(10, 3.0)
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='1m',limit=1500):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.4);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(1.0)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in all_k]  # o,h,l,c,v

def supertrend(kl,period=10,mult=3.0):
    """返回 SuperTrend 上轨/下轨/方向(+1上趋势,-1下趋势)"""
    h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl];o=[x[0] for x in kl]
    n=len(c)
    atr=[0.0]*n
    # ATR(period)
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]))
        atr[i]=(atr[i-1]*(period-1)+tr)/period if i>=period else (atr[i-1]+tr)/i if i>0 else tr
    # basic bands
    hl2=[(h[i]+l[i])/2 for i in range(n)]
    up=[0.0]*n;dn=[0.0]*n;st=[0.0]*n;dirn=[1]*n
    for i in range(n):
        a=atr[i]
        upper=hl2[i]+mult*a
        lower=hl2[i]-mult*a
        # 带宽收敛
        if i>0:
            upper=upper if upper<up[i-1] or c[i-1]>up[i-1] else up[i-1]
            lower=lower if lower>dn[i-1] or c[i-1]<dn[i-1] else dn[i-1]
        up[i]=upper;dn[i]=lower
    # 方向
    for i in range(1,n):
        if c[i]>up[i-1]:dirn[i]=1
        elif c[i]<dn[i-1]:dirn[i]=-1
        elif dirn[i-1]==1:dirn[i]=1 if c[i]>=dn[i] else -1
        elif dirn[i-1]==-1:dirn[i]=-1 if c[i]<=up[i] else 1
        st[i]=dn[i] if dirn[i]==1 else up[i]
    return dirn,up,dn,st

# 简单执行: 每根K线末尾判定, 方向翻转开仓, 反向翻转平仓
def run(kl,mode,stopAtr=1.2):
    dirn,up,dn,st=supertrend(kl)
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);trades=[];pos=0;entry=0;entry_i=0
    SL=2
    if stopAtr:
        # ATR for stop
        atr=[0.0]*n
        for i in range(1,n):
            tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]))
            atr[i]=(atr[i-1]*13+tr)/14 if i>=14 else (atr[i-1]+tr)/i
    for i in range(1,n):
        sig=dirn[i]  # +1 上趋势做多, -1 下趋势做空
        if mode=='trend':
            # 方向翻转
            if sig!=pos:
                # 平旧仓(反向)
                if pos!=0:
                    pnl=((c[i]-entry)/entry*100)*pos
                    trades.append((pos,pnl,'close'))
                # 开新仓
                pos=sig;entry=c[i];entry_i=i
        elif mode=='revert':
            # 震荡反转: 触上轨做空, 触下轨做多 (但只在方向反转时)
            if sig==-1 and pos!=1:
                if pos==-1:
                    pnl=((c[i]-entry)/entry*100)*pos;trades.append((pos,pnl,'close'))
                pos=-1;entry=c[i];entry_i=i
            elif sig==1 and pos!=-1:
                if pos==1:
                    pnl=((c[i]-entry)/entry*100)*pos;trades.append((pos,pnl,'close'))
                pos=1;entry=c[i];entry_i=i
    # 平最后一仓
    if pos!=0:
        pnl=((c[-1]-entry)/entry*100)*pos;trades.append((pos,pnl,'close'))
    wins=[x for x in trades if x[1]>0];losses=[x for x in trades if x[1]<=0]
    acc=len(wins)/len(trades)*100 if trades else 0
    net=sum(x[1] for x in trades)
    return {'acc':acc,'n':len(trades),'net':net,'w':len(wins),'l':len(losses)}

sym='BTCUSDT'
print("拉数据(BTC 1m)...",flush=True)
kl=fetch(sym,'1m',1500)
print(f"1m K线:{len(kl)}根",flush=True)
for mode,label in [('trend','A:SuperTrend趋势跟随'),('revert','B:SuperTrend反转(震荡)')]:
    r=run(kl,mode)
    if r:
        print(f"  {label:<24} 胜率{r['acc']:.1f}% 样本{r['n']} 净盈亏{r['net']:.2f}% ({r['w']}胜{r['l']}负)",flush=True)
