#!/usr/bin/env python3
"""仅SUPER多币多参数, 未来10m方向命中率(剔除平盘)"""
import urllib.request,json,time,math
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,limit=2600):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1m&limit=1000'+(('&endTime='+str(end)) if end else '')
        b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        if not b:break
        ak=b+ak;end=int(b[0][0])-1;time.sleep(0.35)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def SUP(h,l,c,p,m):
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
def runone(sym,p,m,FUT=10):
    kl=fetch(sym);c=[x[3] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];N=len(c)
    if N<300:return None
    d=SUP(h,l,c,p,m);long=(0,0);short=(0,0)
    for i in range(max(150,p+3),N-FUT):
        f=c[i+FUT]-c[i]
        if f==0:continue
        if d[i]==1: long=(long[0]+1,long[1]+(1 if f>0 else 0))
        elif d[i]==-1: short=(short[0]+1,short[1]+(1 if f<0 else 0))
    return (long[1]/long[0]*100 if long[0] else 0,long[0], short[1]/short[0]*100 if short[0] else 0,short[0])
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT']
for p,m in [(10,3),(7,3),(20,3),(15,4)]:
    print(f"\n── SUPER({p},{m}) 参数 → 未来10分钟 ──",flush=True)
    lsum=[];ssum=[]
    for sym in POOL:
        r=runone(sym,p,m)
        if r:
            lu,ln,su,sn=r
            lsum.append(lu);ssum.append(su)
            print(f"  {sym:<9} 多后涨率{lu:5.1f}%(n{ln})  空后跌率{su:5.1f}%(n{sn})",flush=True)
    if lsum: print(f"  ~多均{sum(lsum)/len(lsum):.1f}%  空均{sum(ssum)/len(ssum):.1f}%",flush=True)
