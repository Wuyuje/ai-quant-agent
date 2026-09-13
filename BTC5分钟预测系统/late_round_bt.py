
# late_round_bt.py — 轮末确定性: 用1m数据构造5分钟轮, 测"轮末前X秒偏离"→轮最终涨跌 命中率
import ccxt, time
ex=ccxt.binance({"enableRateLimit":True})
rows=ex.fetch_ohlcv("BTC/USDT","1m",limit=3000)  # 3000分钟=50小时
c=[r[4] for r in rows]; t=[r[0] for r in rows]; n=len(c)
print("1m bars:",n)
# 每5根=一个5分钟轮
res={}
for X in (60,120,180,240):  # 轮末前X秒(即倒数X/60根处) 判断方向
    tot=win=0
    for k in range(0,n-5,5):
        start=c[k]; end=c[k+4]          # 轮起/终(5根)
        idx=k+4-(X//60)                  # 轮末前X秒对应的根
        if idx<=k: continue
        p_mid=c[idx]
        dev=p_mid-start
        if dev==0: continue
        pred=1 if dev>0 else -1
        real=1 if end>start else (-1 if end<start else 0)
        if real==0: continue
        tot+=1; win+= 1 if pred==real else 0
    res[X]= (round(win/tot*100,1) if tot else 0, tot)
for X,(wr,tot) in res.items():
    print(f"轮末前{X}s用偏离方向 → 命中 {wr}% (n={tot})")
# 同时看"偏离幅度"分档
for thr in (0.01,0.02,0.03,0.05):
    tot=win=0
    for k in range(0,n-5,5):
        start=c[k]; end=c[k+4]; p_mid=c[k+3]  # 轮末前1根
        dev=(p_mid-start)/start*100
        if abs(dev)<thr: continue
        pred=1 if dev>0 else -1
        real=1 if end>start else (-1 if end<start else 0)
        if real==0: continue
        tot+=1; win+= 1 if pred==real else 0
    print(f"偏离>{thr}% (轮末前1根) → 命中 {round(win/tot*100,1) if tot else 0}% (n={tot})")
