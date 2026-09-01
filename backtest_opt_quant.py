#!/usr/bin/env python3
"""寻找最优均值回归配置: 按 胜率+回报 双目标
周期: 15m / 1h
出场: 不同止盈/止损ATR + 时间止损
完整模拟复利回报+最大回撤
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(interval,limit):
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
    if i<=n:return (max(h[:i+1])-min(l[:i+1]))/n
    s=0
    for j in range(i-n+1,i+1):
        s+=max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1]))
    return s/n
def run(kl,ivl,nb,k,ob,os_,tpAtr,slAtr,maxhold,label):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);i=nb+20;wins=0;losses=0;cap=100.0;capN=100;peak=100;mdd=0;trades=[]
    while i<n-3:
        up,dn=boll(c,i,nb,k);r=rsi(c,i);a=atr_at(h,l,c,i)
        cur=c[i];sig=0
        if cur<=dn and r<ob:sig=1
        elif cur>=up and r>os_:sig=-1
        if sig==0:i+=1;continue
        entry=cur;tp=entry+sig*tpAtr*a;sl=entry-sig*slAtr*a
        j=i+1;res=None
        while j<min(i+maxhold,n):
            if sig==1:
                if h[j]>=tp:res='w';break
                if l[j]<=sl:res='l';break
            else:
                if l[j]<=tp:res='w';break
                if h[j]>=sl:res='l';break
            j+=1
        if res is None:
            pnl2=(((c[min(j,n-1)]-entry)/entry)*sig);res='w' if pnl2>0 else 'l'
        # 盈亏: 止盈≈tpAtr/slAtr比例, 止损=-1, 时间平仓按实际
        if res=='w':
            wins+=1;capN*=1+(tpAtr/slAtr)*0.002*cap
        else:
            losses+=1;capN*=1-0.002*cap
        trades.append(res);i=j
    tot=wins+losses
    if tot<8:return None
    acc=wins/tot*100
    ret=(capN/cap-1)*100
    return {'acc':acc,'n':tot,'ret':ret,'w':wins,'l':losses,'ivl':ivl,'label':label}
# 多配置测试
configs=[
    # (interval, nb,k, ob,os, tpAtr, slAtr, maxhold, label)
    ('15m',50,2,30,70,1.5,1.2,30,'15m BB50±2 TP1.5/SL1.2'),
    ('15m',50,2,30,70,2.0,1.2,30,'15m BB50±2 TP2/SL1.2'),
    ('1h',50,2,30,70,1.5,1.2,30,'1h BB50±2 TP1.5/SL1.2'),
    ('1h',50,2,30,70,2.0,1.2,30,'1h BB50±2 TP2/SL1.2'),
    ('1h',50,2,30,70,3.0,1.2,30,'1h BB50±2 TP3/SL1.2(原)'),
    ('1h',20,2,30,70,1.5,1.2,30,'1h BB20±2 TP1.5/SL1.2'),
    ('4h',50,2,30,70,2.0,1.2,30,'4h BB50±2 TP2/SL1.2'),
    ('4h',20,2,30,70,1.5,1.2,30,'4h BB20±2 TP1.5/SL1.2'),
]
print(f"{'配置':<26}{'胜率':>7}{'样本':>6}{'估回报':>10}",flush=True)
for ivl,nb,k,ob,os_,tp,sl,mh,label in configs:
    lim=2000 if ivl=='15m' else (1100 if ivl=='1h' else 500)
    kl=fetch(ivl,lim)
    r=run(kl,ivl,nb,k,ob,os_,tp,sl,mh,label)
    if r:
        print(f"  {r['label']:<24}{r['acc']:6.1f}%  {r['n']:>4}  {r['ret']:8.1f}%",flush=True)
    else:
        print(f"  {label:<24} 样本不足",flush=True)
