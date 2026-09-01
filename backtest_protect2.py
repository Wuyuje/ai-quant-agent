#!/usr/bin/env python3
"""均值回归防损对比(干净版) - 聚焦减少亏损
目标: 找到 亏损最少+净利最高 的配置
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(interval,limit=1100):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.4);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(1.2)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in all_k]
def boll(c,i,nb,k):
    w=c[i-nb+1:i+1];m=sum(w)/nb;sd=math.sqrt(sum((x-m)**2 for x in w)/nb)
    return m+k*sd,m-k*sd
def rsi(c,i,p=14):
    gs=ls=0
    for j in range(i-p,i):
        d=c[j]-c[j-1];gs+=max(d,0);ls-=min(d,0)
    if ls==0:return 100
    return 100-100/(1+(gs/p)/(ls/p))
def atr_at(h,l,c,i,n=14):
    s=0
    for j in range(i-n+1,i+1):s+=max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1]))
    return s/n
def run(kl,nb,k,ob,os_,tpAtr,slAtr,maxhold,label):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);i=nb+20;trades=[]
    while i<n-3:
        up,dn=boll(c,i,nb,k);r=rsi(c,i);a=atr_at(h,l,c,i);cur=c[i];sig=0
        if cur<=dn and r<ob:sig=1
        elif cur>=up and r>os_:sig=-1
        if sig==0:i+=1;continue
        entry=cur;tp=entry+sig*tpAtr*a;sl=entry-sig*slAtr*a
        j=i+1;res=None;exitp=None
        while j<min(i+maxhold,n):
            if sig==1:
                if h[j]>=tp:res='w';exitp=tp;break
                if l[j]<=sl:res='l';exitp=sl;break
            else:
                if l[j]<=tp:res='w';exitp=tp;break
                if h[j]>=sl:res='l';exitp=sl;break
            j+=1
        if res is None: exitp=c[min(j,n-1)];res='w' if (exitp-entry)*sig>0 else 'l'
        trades.append((res,((exitp-entry)/entry)*sig*100));i=j
    if len(trades)<8:return None
    wins=[x for x in trades if x[0]=='w'];losses=[x for x in trades if x[0]=='l']
    acc=len(wins)/len(trades)*100
    net=sum(x[1] for x in trades)
    return {'acc':acc,'n':len(trades),'net':net,'losses':len(losses),'worst':min([x[1] for x in losses]) if losses else 0}
configs=[
    (50,2,30,70,2.0,1.2,72,'基准 TP2/SL1.2'),
    (50,2,25,75,2.0,1.2,72,'严入场RSI25-75'),
    (50,2,30,70,2.0,1.0,72,'早止损SL1.0'),
    (50,2,25,75,2.0,1.0,72,'严+早止损'),
    (50,2,25,75,1.5,1.0,72,'严+窄幅TP1.5/SL1.0'),
    (50,2,30,70,1.7,1.1,60,'均衡TP1.7/SL1.1/60h'),
]
print(f"{'配置':<24}{'胜率':>7}{'样本':>6}{'亏损单':>7}{'最大单亏':>9}{'净盈亏%':>9}",flush=True)
kl=fetch('1h',1100)
for nb,k,ob,os_,tp,sl,mh,label in configs:
    r=run(kl,nb,k,ob,os_,tp,sl,mh,label)
    if r:
        print(f"  {label:<22}{r['acc']:6.1f}%  {r['n']:>4}  {r['losses']:>5}   {r['worst']:7.2f}%   {r['net']:8.2f}",flush=True)
    else: print(f"  {label:<24} 样本不足",flush=True)
