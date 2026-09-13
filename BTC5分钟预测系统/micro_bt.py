
import ccxt, math, statistics, time, numpy as np
from sklearn.ensemble import RandomForestClassifier
ex=ccxt.binance({"enableRateLimit":True})
def fetch_1s(limit=1800):
    out=[]; end=None
    while len(out)<limit:
        p={"symbol":"BTC/USDT","timeframe":"1s","limit":1000}
        if end: p["endTime"]=end
        try: d=ex.fetch_ohlcv(**p)
        except: break
        if not d: break
        out=d+out; end=d[0][0]-1; time.sleep(0.6)
    return sorted(out,key=lambda x:x[0])
rows=fetch_1s(9000); c_=[r[4] for r in rows]; v=[r[5] for r in rows]; n=len(c_)
print("1s bars:",n,"覆盖秒:",n)
def feat(i):
    if i<120: return None
    p=c_[i]; f=[]
    for w in (30,60,120): f.append((p-c_[i-w])/(c_[i-w] or 1)*100)
    up=sum(1 for j in range(i-60,i) if c_[j]>c_[j-1]); f.append(up/60.0)
    f.append(sum(v[i-30:i])/(sum(v[i-60:i-30]) or 1))
    seg=[(c_[j+5]-c_[j])/(c_[j] or 1)*100 for j in range(i-60,i-5,5)]
    f.append(statistics.pstdev(seg) if len(seg)>1 else 0)
    return f
X=[];y=[];H=300
for i in range(120,n-H):
    f=feat(i)
    if not f: continue
    fut=c_[i+H]-c_[i]
    if fut==0: continue
    X.append(f); y.append(1 if fut>0 else -1)
X=np.array(X); y=np.array(y); print("samples:",len(X)," 涨/跌:",int((y==1).sum()),int((y==-1).sum()))
if len(set(y.tolist()))<2: print("单类, 无法训练"); raise SystemExit
sp=int(len(X)*0.7)
rf=RandomForestClassifier(n_estimators=300,max_depth=8,random_state=42,n_jobs=2).fit(X[:sp],y[:sp])
pu=rf.predict_proba(X[sp:])[:,1]; te=y[sp:]; pred=np.where(pu>0.5,1,-1)
print("ML整体:",round((pred==te).mean()*100,1),"% n=",len(te))
for t in (0.05,0.1,0.15,0.2,0.25,0.3):
    m=np.abs(pu-0.5)>t
    if m.sum()>5: print(f"  conf>{t}: {round((pred[m]==te[m]).mean()*100,1)}% n={int(m.sum())}")
