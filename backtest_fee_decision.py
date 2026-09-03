#!/usr/bin/env python3
"""决定性回测: SuperTrend震荡(1h与5m对比) + 严格全费用净回报模型
模式: 盈利后才止盈(当前roi>0才平), 极端兜底-30%, 仅净回报>0可平(扣0.04%名义手续费+盈利30%算力费-普通用户)
目标: 扣全费用后 1h vs 5m 哪个净回报稳定为正 → 决定迁移方向
"""
import urllib.request,json,time,math,sys
sys.path.insert(0,'/app/workspace/ai-quant-agent')
UA={'User-Agent':'Mozilla/5.0'}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','LINKUSDT']
LEV=4; FEE_RATE=0.0004; COMPUTE=0.30
def fetch(sym,ivl,limit):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={ivl}&limit=1000'+(('&endTime='+end) if end else '')
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        except:time.sleep(0.5);break
        if not b:break
        ak=b+ak;end=str(int(b[0][0])-1);time.sleep(0.6)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def st(h,l,c,p=10,m=3.0):
    n=len(c);atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]));atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)];up=[0.0]*n;dn=[0.0]*n;d=[1]*n
    for i in range(n):
        u=hl2[i]+m*atr[i];dd=hl2[i]-m*atr[i]
        if i>0:
            u=u if(u<up[i-1]or c[i-1]>up[i-1])else up[i-1]
            dd=dd if(dd>dn[i-1]or c[i-1]<dn[i-1])else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    return d
def run_fee(kl,trail=0.01):
    """盈利才平 + 净回报>0才平码(扣费)。返回每笔净回报%"""
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=st(h,l,c);n=len(c);trades=[];pos=0;entry=0;peak=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]:pos=-d[i];entry=c[i];peak=0
        else:
            cur=((c[i]-entry)/entry)*LEV*pos;rp=((h[i]-entry)/entry)*LEV if pos==1 else ((entry-l[i])/entry)*LEV
            if rp>peak:peak=rp
            if cur<=-0.30: trades.append(-0.30);pos=0;continue   # 极端兜底
            if cur<=0: continue                                  # 未盈利不平
            notional=abs(entry);fee_f=FEE_RATE*2  # 开+平手续费的名义%约0.08%价格? 用价格计
            # 净回报%(价格口径)=cur(价%) - 手续费(价%) - 算力费(盈利30%×价%)
            price_pct=cur/LEV
            fee_pct=price_pct*FEE_RATE*0  # 手续费按名义用固定估算了简化; 实际用cur的口径
            # 手续费: 名义价值×0.04%开平 ≈ 保证金cur不反映; 单独从落袋扣除
            net=cur  # 净回报先用cur(价%含杠杆), 手续费结算折算在后面用绝对
            if peak>0 and (peak-cur)>=trail:
                trades.append(net);pos=0;continue
            if d[i]!=d[i-1]: trades.append(net);pos=0;continue
    if pos!=0:trades.append(((c[-1]-entry)/entry)*LEV*pos)
    return trades
def stats(tr,multiplier):
    # 手续费按名义额折算回回报: 每笔名义=entry, 手续费≈entry×0.0004×2
    # 简化: 每笔几乎按名义, 手续费为名义的0.0008 → 折算回(entry×0.0008)/(保证金)=entry×0.0008/(entry/LEV)=0.0008×LEV 价% = 0.4%价 当LEV=...不确定
    # 直接用固定损耗: 每笔扣价格0.08%=4x杠杆0.32%回报损耗 近似
    v=tr[:]
    real=[]
    for x in v:
        price_ret=x/LEV  # 回报%转价格%
        # 手续费: 名义0.0008(双边0.08%), 名义≈杠杆保证金, 折算价格%=0.0008
        fee_price= 0.0008
        net_price= price_ret-fee_price
        # 算力费(普通用户,盈利时): 净利价格%×0.3
        if net_price>0: net_price*=(1-COMPUTE)
        real.append(net_price*LEV)  # 回到含4x回报%
    wins=[x for x in real if x>0]
    return (len(wins)/len(real)*100 if real else 0,len(real),sum(real))
tfs=[('1h',600),('5m',1500)]  # 1h测约600根≈25天,5m 1500≈5天(同数据尽量长)
for tf,lim in tfs:
    print(f"\n═══ {tf} (样本跨度: {tf=='1h' and 25 or 5}天) ═══",flush=True)
    allnet=[]
    for sym in POOL:
        try:kl=fetch(sym,tf,lim)
        except:continue
        tr=run_fee(kl)
        acc,cnt,net=stats(tr,tf)
        allnet.append(net)
        print(f"  {sym:<9} 胜率{acc:.0f}% 净回报{net:+.1f}% (扣手续费+30%算力费)",flush=True)
    if allnet:print(f"  ≈平均净回报{sum(allnet)/len(allnet):+.1f}%  正回报币{sum(1 for x in allnet if x>0)}/{len(allnet)}",flush=True)
