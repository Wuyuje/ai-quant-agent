
import ccxt, math, time
ex=ccxt.binance({"enableRateLimit":True})
def backtest(symbol="BTC/USDT", tf="5m", limit=3000, p=10, m=3.0, thr=0.5):
    rows=ex.fetch_ohlcv(symbol, tf, limit=limit)
    c=[r[4] for r in rows]; h=[r[2] for r in rows]; l=[r[3] for r in rows]; n=len(c)
    atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1])); atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
    up=[0.0]*n; dn=[0.0]*n; d=[1]*n
    for i in range(n):
        hl=(h[i]+l[i])/2; u=hl+m*atr[i]; dd=hl-m*atr[i]
        if i>0: u=u if (u<up[i-1] or c[i-1]>up[i-1]) else up[i-1]; dd=dd if (dd>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
        up[i]=u; dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]: d[i]=1
        elif c[i]<dn[i-1]: d[i]=-1
        elif d[i-1]==1: d[i]=1 if c[i]>=dn[i] else -1
        else: d[i]=-1 if c[i]<=up[i] else 1
    # 策略: 每根出现信号->预测下一根(=5分钟后)方向
    tot=win=0; sig_tot=0; sig_win=0
    for i in range(25,n-1):
        seg=c[i-19:i+1]; mid=sum(seg)/20; sd=(sum((x-mid)**2 for x in seg)/20)**0.5 or 1e-9
        pos = 1 if c[i]>=mid else -1
        score=1.5*d[i]+0.5*pos
        tdir = 1 if score>=0 else -1
        strength=min(1.0,abs(score)/2)
        nxt = 1 if c[i+1]>c[i] else (-1 if c[i+1]<c[i] else 0)
        if nxt==0: continue
        tot += 1; win += 1 if tdir==nxt else 0
        if strength>thr:
            sig_tot += 1; sig_win += 1 if tdir==nxt else 0
    return dict(symbol=symbol, tf=tf, n=tot, win=win, wr=round(win/tot*100,1) if tot else 0,
                sig_n=sig_tot, sig_win=sig_win, sig_wr=round(sig_win/sig_tot*100,1) if sig_tot else 0)
for tf in ["5m","15m","1h"]:
    for thr in [0.0,0.5,0.8]:
        r=backtest(tf=tf, limit=3000, thr=thr)
        print(f"{tf} thr={thr}: 全样本 {r['wr']}% (n={r['n']}) | 强信号 {r['sig_wr']}% (n={r['sig_n']})", flush=True)
