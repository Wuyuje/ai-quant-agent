#!/usr/bin/env python3
"""纯净SuperTrend跟随策略回测 - 仅用SUPER线
红线(上趋势)→做多  绿线(下趋势)→做空  线色翻转→平仓换方向
不加任何反转/额外指标, 完全跟随SUPER线
周期: 5m, 多币池
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='5m',limit=2000):
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

def supertrend_color(h,l,c,period,mult):
    """返回SUPER线颜色方向: +1=红线上趋势(做多), -1=绿线下趋势(做空), 以及红线/绿线值"""
    n=len(c)
    atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]))
        atr[i]=(atr[i-1]*(period-1)+tr)/period if i>=period else (atr[i-1]+tr)/i if i<=period else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)]
    up=[0.0]*n;dn=[0.0]*n
    for i in range(n):
        upper=hl2[i]+mult*atr[i];lower=hl2[i]-mult*atr[i]
        if i>0:
            upper=upper if (upper<up[i-1] or c[i-1]>up[i-1]) else up[i-1]
            lower=lower if (lower>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
        up[i]=upper;dn[i]=lower
    # 颜色/方向
    dirn=[1]*n;stcolor=['red']*n
    for i in range(1,n):
        if c[i]>up[i-1]:dirn[i]=1;stcolor[i]='red'      # 红线，上趋势
        elif c[i]<dn[i-1]:dirn[i]=-1;stcolor[i]='green'  # 绿线，下趋势
        elif dirn[i-1]==1:
            dirn[i]=1;stcolor[i]='red'
        else:
            dirn[i]=-1;stcolor[i]='green'
    return dirn,stcolor

def run(kl,period,mult):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);dirn,color=supertrend_color(h,l,c,period,mult)
    trades=[];pos=0;entry=0
    for i in range(1,n):
        sig=dirn[i]   # +1 红线做多, -1 绿线做空 (纯跟随)
        if sig!=pos:
            if pos!=0:
                pnl=((c[i]-entry)/entry*100)*pos;trades.append((pnl))
            pos=sig;entry=c[i]
    if pos!=0:
        pnl=((c[-1]-entry)/entry*100)*pos;trades.append(pnl)
    if len(trades)<10:return None
    wins=[x for x in trades if x>0]
    acc=len(wins)/len(trades)*100;net=sum(trades)
    # 分开算做多/做空
    return {'acc':acc,'n':len(trades),'net':net,'w':len(wins)}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','ADAUSDT','LINKUSDT','LTCUSDT']
print(f"{'币':<10}{'参数':<10}{'胜率':>7}{'样本':>5}{'净盈亏%':>9}",flush=True)
for sym in POOL:
    kl=fetch(sym,'5m',2000)
    for (p,m,lab) in [(10,3,'ST10/3'),(10,2,'ST10/2'),(7,3,'ST7/3'),(20,3,'ST20/3')]:
        r=run(kl,p,m)
        if r:
            print(f"  {sym:<8}{lab:<8}{r['acc']:6.1f}%  {r['n']:>4}  {r['net']:8.2f}",flush=True)
        else: print(f"  {sym:<8}{lab:<8} 样本不足",flush=True)
