#!/usr/bin/env python3
"""回测: 修改后震荡策略 - 回归中轨止盈 + 固定1.2ATR止损
入场: 布林触轨 + RSI反转(超卖做多/超买做空)
止盈: 价格回归布林中轨(mid)
止损: 固定1.2ATR
周期: 1h
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(interval='1h',limit=1100):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.4);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(1.2)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in all_k]  # o,h,l,c
def boll(c,i,nb,k):
    w=c[i-nb+1:i+1];m=sum(w)/nb;sd=math.sqrt(sum((x-m)**2 for x in w)/nb)
    return m+k*sd,m,m-k*sd
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
def run(kl,nb,k,ob,os_,slAtr,label):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);i=nb+20;trades=[]
    while i<n-3:
        up,mid,dn=boll(c,i,nb,k);r=rsi(c,i);a=atr_at(h,l,c,i);cur=c[i];sig=0
        if cur<=dn and r<ob:sig=1
        elif cur>=up and r>os_:sig=-1
        if sig==0:i+=1;continue
        entry=cur;sl=entry-sig*slAtr*a
        # 扫描后续: 先触中轨(止盈) 或 先触止损
        j=i+1;res=None;exitp=None
        while j<n:
            hh,mm,dd=boll(c,j,nb,k)
            if sig==1:
                if h[j]>=mm:res='w';exitp=mm;break   # 回归中轨止盈
                if l[j]<=sl:res='l';exitp=sl;break    # 固定止损
            else:
                if l[j]<=mm:res='w';exitp=mm;break
                if h[j]>=sl:res='l';exitp=sl;break
            j+=1
        if res is None:break  # 数据尽头
        pnl_pct=((exitp-entry)/entry)*sig*100
        trades.append((res,pnl_pct));i=j
    if len(trades)<8:return None
    wins=[x for x in trades if x[0]=='w'];losses=[x for x in trades if x[0]=='l']
    acc=len(wins)/len(trades)*100
    net=sum(x[1] for x in trades)
    avgW=np.mean([x[1] for x in wins]) if wins else 0
    avgL=np.mean([x[1] for x in losses]) if losses else 0
    # 前后段稳定性
    half=int(len(trades)/2)
    h1=trades[:half];h2=trades[half:]
    a1=100*sum(1 for x in h1 if x[0]=='w')/len(h1) if h1 else 0
    a2=100*sum(1 for x in h2 if x[0]=='w')/len(h2) if h2 else 0
    return {'acc':acc,'n':len(trades),'net':net,'avgW':avgW,'avgL':avgL,'a1':a1,'a2':a2}
print(f"{'配置':<26}{'胜率':>7}{'样本':>6}{'均盈%':>7}{'均亏%':>7}{'净盈亏%':>9}{'前半':>7}{'后半':>7}",flush=True)
for nb,k,ob,os_,sl,label in [
    (50,2,30,70,1.2,'BB50±2 RSI30-70 回归中轨/SL1.2'),
    (20,2,30,70,1.2,'BB20±2 RSI30-70 回归中轨/SL1.2'),
    (50,2,25,75,1.2,'BB50±2 RSI25-75 回归中轨/SL1.2'),
    (50,2,30,70,0.02,'BB50±2 RSI30-70 回归中轨/SL2%'),
]:
    kl=fetch('1h',1100)
    r=run(kl,nb,k,ob,os_,sl,label)
    if r:
        st='✅稳定' if r['a1']>55 and r['a2']>55 else('⚠️分化' if min(r['a1'],r['a2'])<52 else '➖一般')
        print(f"  {label:<24}{r['acc']:6.1f}%  {r['n']:>4}  {r['avgW']:6.2f} {r['avgL']:6.2f}  {r['net']:8.2f}  {r['a1']:5.1f}% {r['a2']:5.1f}%  {st}",flush=True)
    else: print(f"  {label:<26} 样本不足",flush=True)
