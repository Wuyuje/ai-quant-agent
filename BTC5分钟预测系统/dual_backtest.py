
# dual_backtest.py — 币安tech 与 TWAP偏离(用5m历史近似) 双同向 → 预测下一根胜率
import ccxt, math, time
ex=ccxt.binance({"enableRateLimit":True})
rows=ex.fetch_ohlcv("BTC/USDT","5m",limit=3000)
c=[r[4] for r in rows]; h=[r[2] for r in rows]; l=[r[3] for r in rows]; n=len(c)
p,m=10,3.0; atr=[0.0]*n; up=[0.0]*n; dn=[0.0]*n; d=[1]*n
for i in range(1,n):
    tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1])); atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
for i in range(n):
    hl=(h[i]+l[i])/2; u=hl+m*atr[i]; dd=hl-m*atr[i]
    if i>0: u=u if (u<up[i-1] or c[i-1]>up[i-1]) else up[i-1]; dd=dd if (dd>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
    up[i]=u; dn[i]=dd
for i in range(1,n):
    if c[i]>up[i-1]: d[i]=1
    elif c[i]<dn[i-1]: d[i]=-1
    elif d[i-1]==1: d[i]=1 if c[i]>=dn[i] else -1
    else: d[i]=-1 if c[i]<=up[i] else 1
def tech(i):
    seg=c[i-19:i+1]; mid=sum(seg)/20; pos=1 if c[i]>=mid else -1
    sc=1.5*d[i]+0.5*pos
    return 1 if sc>=0 else -1
def twap_dev_dir(i, win=5):
    # 用过去win根(25分钟)近似"轮内TWAP偏离方向": 当前 vs win根前
    if i<win: return None
    return 1 if c[i]>c[i-win] else (-1 if c[i]<c[i-win] else None)
stats={"dual":{0:[0,0]}, "twap_only":{0:[0,0]}, "tech_only":{0:[0,0]}}
for i in range(40,n-1):
    fut=c[i+1]-c[i]
    if fut==0: continue
    real=1 if fut>0 else -1
    t=tech(i); wd=twap_dev_dir(i,5)
    if wd is None: continue
    # tech only
    stats["tech_only"][0][0]+=1; stats["tech_only"][0][1]+= 1 if t==real else 0
    # twap only
    stats["twap_only"][0][0]+=1; stats["twap_only"][0][1]+= 1 if wd==real else 0
    # dual (同向才触发)
    if t==wd:
        stats["dual"][0][0]+=1; stats["dual"][0][1]+= 1 if t==real else 0
for k,(v) in stats.items():
    tot,hit=v[0]
    print(f"{k}: {round(hit/tot*100,1)}% (n={tot})" if tot else f"{k}: 0")
