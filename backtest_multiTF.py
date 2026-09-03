#!/usr/bin/env python3
"""布林×SUPER倾斜, 多周期命运: 预测'该周期一根后'(30m/1h事件盘口径)
命中= 下一相等周期K线收盘方向
"""
import urllib.request,json,time,math
from collections import defaultdict
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,ivl,limit=1400):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={ivl}&limit=1000'+(('&endTime='+str(end)) if end else '')
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        except:time.sleep(0.4);break
        if not b:break
        ak=b+ak;end=int(b[0][0])-1;time.sleep(0.4)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def bollv(c,i,n=20,k=2):
    s=c[max(0,i-n+1):i+1];m=sum(s)/n;sd=math.sqrt(sum((x-m)**2 for x in s)/n) or 1e-9
    return m,m+k*sd,m-k*sd
def SUPER_both(h,l,c,p=10,m=3.0):
    n=len(c);atr=[0.]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]));atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)];up=[0.]*n;dn=[0.]*n;d=[1]*n;val=[0.]*n
    for i in range(n):
        u=hl2[i]+m*atr[i];dd=hl2[i]-m*atr[i]
        if i>0:u=u if(u<up[i-1]or c[i-1]>up[i-1])else up[i-1];dd=dd if(dd>dn[i-1]or c[i-1]<dn[i-1])else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    for i in range(n): val[i]=dn[i] if d[i]==1 else up[i]
    return d,val
def stat(sym,ivl):
    kl=fetch(sym,ivl);c=[x[3] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];N=len(c)
    if N<200:return
    d,val=SUPER_both(h,l,c);acc=defaultdict(lambda:[0,0]);FUT=1
    for i in range(150,N-FUT):
        gg=min(200,N);_m,_up,_dn=bollv(c,i)
        pos=c[i]; zone='top' if c[i]>=_up else ('midup' if c[i]>=_m else ('midlo' if c[i]>=_dn else 'bot'))
        if i-4>=0: sl=(val[i]-val[i-4])/(1e-9+abs(val[i-4]))
        else: continue
        flat=abs(sl)<0.00003
        st_cur=d[i]
        if st_cur==1 and sl>0.00006 and not flat: key=f'红上倾[{zone}]买涨'
        elif st_cur==-1 and sl<-0.00006 and not flat: key=f'蓝下倾[{zone}]买跌'
        else: continue
        fw=c[i+FUT]-c[i]
        if fw==0:continue
        right = fw>0 if key.endswith('买涨') else fw<0
        acc[key][0]+=1
        if right: acc[key][1]+=1
    if not acc: return
    print(f"—— {sym} [{ivl}] 命中率(未来1根) vs 55.6%保本 ——",flush=True)
    for k,(n,hit) in sorted(acc.items(),key=lambda x:-x[1][0]):
        if n>=10:
            r=hit/n*100
            mark='✅' if r>55.6 else '❌'
            print(f"  {k:<22} 样本{n:>4}  命中{r:5.1f}%  {mark}",flush=True)
for ivl in ['30m','1h']:
    print(f"\n===== 周期 {ivl} =====",flush=True)
    for s in ['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT']:
        stat(s,ivl)
