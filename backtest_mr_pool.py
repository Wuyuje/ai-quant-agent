#!/usr/bin/env python3
"""回测: 量化机器人系统震荡策略(改后纯均值回归出场)
按引擎真实配置: 优选币池14币 + 1h周期 + BB50±2 + RSI30-70
止盈=回归布林中轨 / 止损=固定1.2ATR (其他去除)
汇总全部币: 总胜率/净盈亏/稳定度
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
POOL=['DOGEUSDT','ADAUSDT','INJUSDT','IMXUSDT','SUIUSDT','ARBUSDT','DOTUSDT','XRPUSDT','ETHUSDT','SOLUSDT','LTCUSDT','APTUSDT','SEIUSDT','LINKUSDT']
def fetch(sym,interval='1h',limit=1100):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.4);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(1.0)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in all_k]
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
def run(kl,nb,k,ob,os_,slAtr):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);i=nb+20;trades=[]
    while i<n-3:
        up,mid,dn=boll(c,i,nb,k);r=rsi(c,i);a=atr_at(h,l,c,i);cur=c[i];sig=0
        if cur<=dn and r<ob:sig=1
        elif cur>=up and r>os_:sig=-1
        if sig==0:i+=1;continue
        entry=cur;sl=entry-sig*slAtr*a
        j=i+1;res=None;exitp=None
        while j<n:
            hh,mm,dd=boll(c,j,nb,k)
            if sig==1:
                if h[j]>=mm:res='w';exitp=mm;break
                if l[j]<=sl:res='l';exitp=sl;break
            else:
                if l[j]<=mm:res='w';exitp=mm;break
                if h[j]>=sl:res='l';exitp=sl;break
            j+=1
        if res is None:break
        trades.append((res,((exitp-entry)/entry)*sig*100));i=j
    if len(trades)<5:return None
    wins=[x for x in trades if x[0]=='w'];losses=[x for x in trades if x[0]=='l']
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(x[1] for x in trades),'w':len(wins),'l':len(losses)}
print(f"{'币种':<12}{'胜率':>7}{'样本':>5}{'净盈亏%':>9}{'胜':>4}{'负':>4}",flush=True)
tot_w=tot_l=0;tot_net=0;coins=0
for sym in POOL:
    kl=fetch(sym)
    r=run(kl,50,2,30,70,1.2)
    if r:
        tot_w+=r['w'];tot_l+=r['l'];tot_net+=r['net'];coins+=1
        print(f"  {sym:<10}{r['acc']:6.1f}%  {r['n']:>4}  {r['net']:8.2f}  {r['w']:>3} {r['l']:>3}",flush=True)
    else:
        print(f"  {sym:<12} 数据/样本不足",flush=True)
if tot_w+tot_l>0:
    print(f"\n═══ 汇总({coins}币) ═══")
    print(f"  总样本:{tot_w+tot_l}  总胜率:{tot_w/(tot_w+tot_l)*100:.1f}%  总净盈亏:{tot_net:.2f}%",flush=True)
