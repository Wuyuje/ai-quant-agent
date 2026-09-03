#!/usr/bin/env python3
"""SUPER×布林 候选信号 → 未来10分钟方向(每信号1笔, 命中率)"
对每根K, 判定属哪个候选策略(前瞻用未来10分钟判胜负)
候选:
  A 顺势延续: SUPER多 且 价在中上但未触上轨 → 做多(赌tail继续)
  B 触轨回归: 价触上轨 -> 做空(赌回中); 触下轨 -> 做多
  方向只取相关(SUPER方向)顺势
"""
import urllib.request,json,time,math
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,limit):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1m&limit=1000'+(('&endTime='+str(end)) if end else '')
        b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        if not b:break
        ak=b+ak;end=int(b[0][0])-1;time.sleep(0.4)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def SUP(h,l,c,p=10,m=3.0):
    n=len(c);atr=[0.]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]));atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)];up=[0.]*n;dn=[0.]*n;d=[1]*n
    for i in range(n):
        u=hl2[i]+m*atr[i];dd=hl2[i]-m*atr[i]
        if i>0:u=u if(u<up[i-1]or c[i-1]>up[i-1])else up[i-1];dd=dd if(dd>dn[i-1]or c[i-1]<dn[i-1])else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1: d[i]=1 if c[i]>=dn[i] else -1
        else: d[i]=-1 if c[i]<=up[i] else 1
    return d
def B(c,i,n=20,k=2.3):
    s=c[i-n+1:i+1];m=sum(s)/n;sd=math.sqrt(sum((x-m)**2 for x in s)/n) or 1e-9
    return m,m+k*sd,m-k*sd

def run(sym):
    kl=fetch(sym,2600);c=[x[3] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];N=len(c)
    if N<300:return None
    d=SUP(h,l,c)
    res={}
    for i in range(120,N-10):
        mid,up,dn=B(c,i)
        f10= 1 if c[i+10]>c[i] else(-1 if c[i+10]<c[i] else 0)
        if f10==0:continue
        # 区间
        zone = 'top' if c[i]>=up else ('bottom' if c[i]<=dn else('uppermid' if c[i]>=mid else 'lowermid'))
        sp=d[i]
        # 潜在做多/做空依据, 用SUPER顺势
        if sp:
            # 顺势多候选: SUPER多且价在布林中上(未触顶高位但不极端) 做多
            s=''
            if sp==1 and zone in ('uppermid',):
                s='顺多中上做多'
            elif sp==1 and zone=='top':
                s='顺多触顶做空(回归)'
            elif sp==-1 and zone=='bottom':
                s='顺空触底做多(回归)'
            elif sp==-1 and zone=='lowermid':
                s='顺空中下做空'
            elif sp==1 and zone=='bottom':
                s='逆布林超卖反做多'
            elif sp==-1 and zone=='top':
                s='逆布林超买反做空'
            if s:
                ac='做多' if ('做多' in s) else ('做空' if '做空' in s else s)
                # 命中: 做多则f10>0; 做空则f10<0
                hit= (f10>0 if ac=='做多' else (f10<0 if ac=='做空' else None))
                res.setdefault(s,[0,0]);res[s][0]+=1;res[s][1]+= 1 if hit else 0
    print(f"\n═══ {sym}: SUPER顺势/布林区 → 未来10分钟命中 ═══",flush=True)
    for k,(n,hit) in res.items():
        if n>=20: print(f"  {k:<16} 样本{n:>5}  命中率{hit/n*100:>5.1f}%",flush=True)
run('BTCUSDT')
