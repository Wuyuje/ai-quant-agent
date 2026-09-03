#!/usr/bin/env python3
"""SUPER线+布林线 组合 → 未来10分钟(10根1m)方向 胜率验证
对各组合状态分组统计未来10分钟上涨概率
状态:
  SP=SUPER方向(1红多/-1绿空)
  布林位置 ppos: price与 上/中/下轨 的关系
  回归/惯性判别
目标: 找出能把未来10分钟方向胜率推到>55%的组合
"""
import urllib.request,json,time,math
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym='BTCUSDT',limit=2000):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1m&limit=1000'+(('&endTime='+str(end)) if end else '')
        b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        if not b:break
        ak=b+ak;end=int(b[0][0])-1;time.sleep(0.4)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]

def SUPER(h,l,c,p=10,m=3.0):
    n=len(c);atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]));atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)];up=[0.]*n;dn=[0.]*n;d=[1]*n
    for i in range(n):
        u=hl2[i]+m*atr[i];dd=hl2[i]-m*atr[i]
        if i>0:
            u=u if(u<up[i-1]or c[i-1]>up[i-1])else up[i-1];dd=dd if(dd>dn[i-1]or c[i-1]<dn[i-1])else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    return d
def bollmm(c,i,n=20,k=2.0):
    seg=c[i-n+1:i+1];m=sum(seg)/n;sd=math.sqrt(sum((x-m)**2 for x in seg)/n) or 1e-9
    return m,m+k*sd,m-k*sd

def main(sym):
    kl=fetch(sym,2600); c=[x[3] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];N=len(c)
    if N<400:print(sym,"数据少");return None
    d=SUPER(h,l,c)
    # (真正统计在下方第二个循环)
    # 统计组合
    from collections import defaultdict
    stat=defaultdict(lambda:[0,0])  # state -> [n,up]
    for i in range(50,N-10):
        mid,up,dn=bollmm(c,i)
        bandzone='up' if c[i]>=mid else 'low'
        sp=d[i]
        # 外轨?
        near_u = c[i]>=up
        near_d = c[i]<=dn
        fut=c[i+10]  #10分钟
        up_fut=1 if fut>c[i] else(-1 if fut<c[i] else 0)
        if up_fut==0:continue
        # 组合A: SUPER顺势且近外轨背离
        if sp==1 and near_u:
            stat['顺势多+触上轨'][1]+=up_fut;stat['顺势多+触上轨'][0]+=1
        if sp==1 and not near_u:
            stat['顺势多+未触顶'][1]+=up_fut;stat['顺势多+未触顶'][0]+=1
        if sp==-1 and near_d:
            stat['顺势空+触下轨'][1]+=up_fut;stat['顺势空+触下轨'][0]+=1
        if sp==-1 and not near_d:
            stat['顺势空+未触底'][1]+=up_fut;stat['顺势空+未触底'][0]+=1
        # 组合B: 布林反弹回归(触下轨+super多? 或 触下轨后回归)
        if c[i]>mid and sp==1: stat['多排+在中上'][1]+=up_fut;stat['多排+在中上'][0]+=1
        if c[i]<mid and sp==-1: stat['空排+在中下'][1]+=up_fut;stat['空排+在中下'][0]+=1
        stat['整体'][1]+=up_fut;stat['整体'][0]+=1
    print(f"\n═══ {sym} SUPER+布林组合 → 未来10分钟方向 ═══",flush=True)
    print(f"{'状态':<20}{'样本':>6}{'涨率':>8}{'涨跌胜率':>10}",flush=True)
    for k,(n,up) in stat.items():
        if n>=15: print(f"  {k:<18}{n:>6}{up/n*100:>7.1f}%  {'多'+str(round(up/n*100))}",flush=True)
main('BTCUSDT')
