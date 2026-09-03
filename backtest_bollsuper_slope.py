#!/usr/bin/env python3
"""布林(上/中/下轨) + SUPER倾斜(红上倾买涨/蓝下倾买跌/平行停) 
规则→ 触发时点 做预判, 看未来10根(分钟)涨跌(命中)
SUPER 线(取实际线值 superline: 上趋势=下轨线,下趋势=上轨线? 实际上SUPER显示为跟随价的一条折线)
倾斜: 线位 t 的3根变化斜率 dirS=sign(t[i]-t[i-3]) , but 因随价波动. 用'线是否上行(open above)' red/green
简化实现遵循你说的: SUPER(红=上升,可作为买涨) 若 其短期斜率为正且>th 判'上倾'->买涨候选;
绿=下降 '下倾'->买跌候选; |斜率|小<平行阈 判'平行'->停.
布林位置佐证: 在上轨上/中/下轨下, 分3组合统计.
"""
import urllib.request,json,time,math
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,limit=2600):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1m&limit=1000'+(('&endTime='+str(end)) if end else '')
        b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        if not b:break
        ak=b+ak;end=int(b[0][0])-1;time.sleep(0.4)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def bollv(c,i,n=20,k=2):
    s=c[i-n+1:i+1];m=sum(s)/n;sd=math.sqrt(sum((x-m)**2 for x in s)/n) or 1e-9
    return m,m+k*sd,m-k*sd
def SUPER_both(h,l,c,p=10,m=3.0):
    """同时返回 dir(1上-1下)与 superline 值序列(红/绿阶段 val)"""
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
    # superline跟随: 上升趋势(dir=1)用下轨值dn, 下降用上轨值up (作为触摸折线)
    for i in range(n):
        val[i]=dn[i] if d[i]==1 else up[i]
    return d,val
def stat(sym):
    kl=fetch(sym);c=[x[3] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];N=len(c)
    d,val=SUPER_both(h,l,c)
    grand={}
    FUT=10
    from collections import defaultdict
    acc=defaultdict(lambda:[0,0])
    for i in range(150,N-FUT):
        up,mid,dn = bollv(c,i)
        pos= c[i]
        # zone by band relative: 1 above up, 0 between (or >mid upper half), 2 below mid lower, 3 below dn
        # 但核心是super方向与倾斜
        st_cur=d[i]
        # 倾斜: superline 3步斜率
        if i-4>=0:
            sl=(val[i]-val[i-4])/(val[i-4] or 1)
        else: continue
        # 平行判定
        flat = abs(sl) < 0.00005   # 极平
        # 状态
        zone='top' if c[i]>=up else ('midup' if c[i]>=mid else ('midlo' if c[i]>=dn else 'bot'))
        if st_cur==1 and sl>0.0001 and not flat:
            key=f'红上倾[{zone}]买涨'
        elif st_cur==-1 and sl<-0.0001 and not flat:
            key=f'蓝下倾[{zone}]买跌'
        elif flat:
            key='平行停'
        else:
            key=('红平行' if st_cur==1 else '蓝平行')
        fut=c[i+FUT]
        if fut==c[i]: continue
        up_fut = fut>c[i]
        # 命中: 买涨->真涨, 买跌->真跌
        if key.startswith('红上倾'): hit=up_fut
        elif key.startswith('蓝下倾'): hit=(not up_fut)
        else: hit=None
        acc[key][0]+=1
        if hit is not None and hit: acc[key][1]+=1
    print(f"\n═══ {sym} 布林带×SUPER倾斜 → 未来10分钟 ═══",flush=True)
    for k,(n,hit) in sorted(acc.items(),key=lambda x:-x[1][0]):
        print(f"  {k:<20} 样本{n:>4}  命中率{hit/n*100 if n else 0:.1f}%",flush=True)
import sys
for s in ['ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','BTCUSDT']:
    if 'sys' not in dir():pass
    exec("stat('"+s+"')")
