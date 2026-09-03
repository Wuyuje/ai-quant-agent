#!/usr/bin/env python3
"""均值回归防损优化回测 - 目标: 减少亏损/最大回撤, 而非单纯追胜率
测试方向:
  A. 严入场(更极端RSI)
  B. 顺势过滤(ADX低=真震荡才做)
  C. 更早止损(1.0ATR)
  D. 组合: 严入场+早止损
核心指标: 胜率/盈亏比/净盈利/最大单笔亏/最大回撤
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
def adx(c,i,n=14):
    # 简化ADX: 用|方向|动量 近似(趋势强度)
    if i<2*n:return 25
    plus=minus=0
    for j in range(i-n+1,i+1):
        dm=c[j]-c[j-1];np_=0;nm_=0
        if dm>0:np_=dm
        elif dm<0:nm_=-dm
        plus+=np_;minus+=nm_
    if plus+minus==0:return 25
    di=abs(plus-minus)/(plus+minus)*100
    # 简化(平稳处理)
    return di
def atr_at(h,l,c,i,n=14):
    s=0
    for j in range(i-n+1,i+1):
        s+=max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1]))
    return s/n
def run(kl,ivl,nb,k,ob,os_,tpAtr,slAtr,maxhold,adxMax,label):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);i=nb+20;trades=[]
    while i<n-3:
        up,dn=boll(c,i,nb,k);r=rsi(c,i);a=atr_at(h,l,c,i);ad=adx(c,i)
        cur=c[i];sig=0
        # 顺势过滤: 仅当 ADX<adxMax(真震荡) 才做, 防趋势亏
        if ad<=adxMax:
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
        if res is None:
            exitp=c[min(j,n-1)];res='w' if (exitp-entry)*sig>0 else 'l'
        pnl_pct=((exitp-entry)/entry)*sig*100
        trades.append((res,pnl_pct));i=j
    if len(trades)<8:return None
    wins=[x for x in trades if x[0]=='w'];losses=[x for x in trades if x[0]=='l']
    acc=len(wins)/len(trades)*100
    avgW=np.mean([x[1] for x in wins]) if wins else 0
    avgL=np.mean([x[1] for x in losses]) if losses else 0
    # 复利资金曲线(每笔风险0.5%本金)
    cap=100.0;peak=100;mdd=0;worst=0
    for res,pct in trades:
        r=abs(pct)/abs(avgL) if avgL else 1  # 笔数
        bet=cap*0.005
        pnl=bet*(tpAtr/slAtr) if res=='w' else -bet
        cap+=pnl
        worst=min(worst,pnl)
        peak=max(peak,cap);mdd=max(mdd,(peak-cap)/peak*100)
    return {'acc':acc,'n':len(trades),'avgW':avgW,'avgL':avgL,'worst':worst,'mdd':mdd,'net':(cap-100)}
configs=[
    ('1h',50,2,30,70,2.0,1.2,72,25,'1h 原配置(基准)'),
    ('1h',50,2,30,70,2.0,1.2,72,18,'1h 严ADX<18'),
    ('1h',50,2,25,75,2.0,1.2,72,25,'1h 更极端RSI25-75'),
    ('1h',50,2,25,75,2.0,1.2,72,18,'1h 极严(RSI25/ADX18)'),
    ('1h',50,2,30,70,2.0,1.0,72,25,'1h 早止损SL1.0'),
    ('1h',50,2,25,75,1.5,1.0,72,18,'1h 严+早止损TP1.5/SL1.0'),
]
print(f"{'配置':<24}{'胜率':>7}{'样本':>6}{'均盈%':>7}{'均亏%':>7}{'最大单亏':>8}{'回撤%':>7}{'净利$':>8}",flush=True)
for ivl,nb,k,ob,os_,tp,sl,mh,adm,label in configs:
    kl=fetch(ivl,1100)
    r=run(kl,ivl,nb,k,ob,os_,tp,sl,mh,adm,label)
    if r:
        print(f"  {label:<24}{r['acc']:6.1f}%  {r['n']:>4}  {r['avgW']:6.2f} {r['avgL']:6.2f}  {r['worst']:7.2f}% {r['mdd']:6.1f}%  {r['net']:7.1f}",flush=True)
    else:
        print(f"  {label:<26} 样本不足",flush=True)
