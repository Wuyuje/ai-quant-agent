#!/usr/bin/env python3
"""仅SUPER线(1分钟) → 推理未来10分钟(10根)方向 命中率
无任何其它指标。SUPER多→做多、SUPER空→做空, 看10分钟后命中(顺SUPER方向)
也测独立事件更严格(每翻转发一次信号)与每K全量评价
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
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    return d
def run(sym,FUT=10,p=10,m=3.0):
    kl=fetch(sym,3000);c=[x[3] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];N=len(c)
    if N<300:return None
    d=SUP(h,l,c)
    # A. 每根K全量: 当前SUPER方向 → FUT根后
    mt=0;mv=0;st=0;sv=0
    for i in range(150,N-FUT):
        if d[i]==1: mt+=1; mv += (1 if c[i+FUT]>c[i] else 0) if c[i+FUT]!=c[i] else (c[i+FUT]>c[i])
        elif d[i]==-1: st+=1; sv += (1 if c[i+FUT]<c[i] else 0) if c[i+FUT]!=c[i] else (c[i+FUT]<c[i])
    # 用不计平盘净
    def uprate(x):return x
    mup= uprate(mv); su2n=sv
    mtotal=mt; stotal=st
    # 平盘剔除更准: 重新数排除相等
    mt2=mv2=st2=sv2=0
    for i in range(150,N-FUT):
        f=c[i+FUT]-c[i]
        if f==0:continue
        if d[i]==1: mt2+=1; mv2 += 1 if f>0 else 0
        elif d[i]==-1: st2+=1; sv2 += 1 if f<0 else 0
    print(f"\n═══ {sym}: 仅SUPER(1m) → 未来{FUT}分钟 ═══",flush=True)
    print(f"[全量每K] SUPER多 后{FUT}min上涨率 {mv2/max(mt2,1)*100:.1f}% (n={mt2})",flush=True)
    print(f"[全量每K] SUPER空 后{FUT}min下跌率 {sv2/max(st2,1)*100:.1f}% (n={st2})",flush=True)
run('BTCUSDT')
