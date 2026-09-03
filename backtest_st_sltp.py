#!/usr/bin/env python3
"""SuperTrend反转 + 主动止盈止损 最优参数校准回测
入场: SUPER(10,3)翻转点反转开仓(触上轨做空/触下轨做多)
出场: 主动止损(SL%) + 主动止盈(TP%) (优先于SUPER翻转)
目标: 找 净盈亏最高 + 胜率可接受 的 SL/TP 组合
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='5m',limit=2500):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.35);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.8)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in all_k]
def st_dir(h,l,c,p,m):
    n=len(c);atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]));atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)];up=[0.0]*n;dn=[0.0]*n;d=[1]*n
    for i in range(n):
        u=hl2[i]+m*atr[i];dd=hl2[i]-m*atr[i]
        if i>0:
            u=u if (u<up[i-1] or c[i-1]>up[i-1]) else up[i-1]
            dd=dd if (dd>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    return d
def run(kl,sl_pct,tp_pct,MAXH=60):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=st_dir(h,l,c,10,3);n=len(c)
    trades=[];pos=0;entry=0;ei=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]:
                pos=-d[i];entry=c[i];ei=i
        else:
            # 持仓中: 优先止盈止损
            pnl=(h[i]>=entry*(1+tp_pct) and pos==1) or (l[i]<=entry*(1-tp_pct) and pos==-1)
            pnl_loss=(l[i]<=entry*(1-sl_pct) and pos==1) or (h[i]>=entry*(1+sl_pct) and pos==-1)
            closed=False
            if pnl_loss: trades.append(-sl_pct*100);pos=0;closed=True
            elif pnl: trades.append(tp_pct*100);pos=0;closed=True
            elif (i-ei)>=MAXH: # 时间出场
                r=((c[i]-entry)/entry)*pos;trades.append(r*100);pos=0;closed=True
            # SUPER翻转兜底
            elif d[i]!=d[i-1]:
                r=((c[i]-entry)/entry)*pos;trades.append(r*100);pos=0;closed=True
    if pos!=0: trades.append((((c[-1]-entry)/entry)*100)*pos)
    if len(trades)<10:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
POOL=['BTCUSDT','ETHUSDT','DOGEUSDT','SOLUSDT','XRPUSDT','ADAUSDT','LINKUSDT']
cfgs=[(0.006,0.008),(0.008,0.010),(0.010,0.013),(0.010,0.015),(0.012,0.015),(0.008,0.013)]
cli=[[],[],[],[],[],[]]
print(f"{'币':<9}"+' '.join(f"{'SL%.1f/TP%.1f'%(c[0]*100,c[1]*100):>15}" for c in cfgs),flush=True)
for sym in POOL:
    kl=fetch(sym,'5m',2500)
    line=f"  {sym:<7}"
    for si,(sl,tp) in enumerate(cfgs):
        r=run(kl,sl,tp)
        if r:
            cli[si].append(r['acc'])
            line+=f"{r['acc']:5.1f}%/{r['net']:+6.1f}%".rjust(14)
        else: line+=f"{'--':>13}"
    print(line,flush=True)
print("\n平均胜率:", ' '.join(f"{(sum(x)/len(x) if x else 0):4.1f}%" for x in cli))
