#!/usr/bin/env python3
"""BTC 10分钟涨跌预测 v2 - 更多天数据 + 更全特征 + 大级别趋势过滤"""
import urllib.request,json,time,math,os,sys
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
DATA_DIR=os.path.dirname(os.path.abspath(__file__))
def fetch_1m(days):
    all_k=[];end=None;need=days*1440
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000'
        if end:url+=f'&endTime={end}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=15).read())
        except:time.sleep(0.3);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.05)
        if len(b)<1000:break
    all_k.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[4]),float(x[2]),float(x[3]),float(x[5])) for x in all_k]
def tech_feats(rows,i):
    if i<200:return None
    c=[r[1] for r in rows[:i+1]];h=[r[2] for r in rows[:i+1]];l=[r[3] for r in rows[:i+1]];v=[r[4] for r in rows[:i+1]]
    p=c[i];f=[]
    def ema(a,n):
        k=2/(n+1);e=a[0]
        for x in range(1,len(a)):e=a[x]*k+e*(1-k)
        return e
    # 动量多周期
    for n in [2,3,5,8,13,21]:
        f.append((p-c[i-n])/(c[i-n] or 1)*100)
    # RSI 14, 7
    for nn in [7,14]:
        if i>=nn+1:
            g=l_=0
            for j in range(i-nn+1,i+1):
                d=c[j]-c[j-1]
                if d>0:g+=d
                else:l_-=d
            f.append(100-100/(1+(g/l_ if l_>0 else 99)))
        else:f.append(50)
    # 布林位置 + 宽度
    seg=c[i-20:i];m=sum(seg)/20;sd=math.sqrt(sum((x-m)**2 for x in seg)/20)
    up=m+2*sd;lo=m-2*sd
    f.append((p-lo)/((up-lo) or 1)*100)
    f.append((up-lo)/p*100)
    # MACD(DIF/DEA)
    e12=ema(c[i-40:],12);e26=ema(c[i-40:],26);e9=ema([ema(c[max(0,i-40+k):],12)-ema(c[max(0,i-40+k):],26) for k in range(0,34)],9) if i>40 else 0
    dif=e12-e26
    f.append(dif/p*100)
    # ATR14相对
    if i>=14:
        trs=[max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])) for j in range(i-13,i+1)]
        f.append(sum(trs)/14/p*100)
    else:f.append(0)
    # 量比+近期量趋势
    if i>=25:
        vn=sum(v[i-4:i+1])/5;vp=sum(v[i-24:i-4])/20
        f.append(vn/vp if vp>0 else 1)
    else:f.append(1)
    # 大级别趋势: 60/240根(≈1h/4h) EMA排列
    for L in [240]:
        if i>=L:
            cw=c[-L:]
            e7=ema(cw,7);e25=ema(cw,25);e99=ema(cw,99)
            f.append(1 if e7>e25 and e25>e99 else (-1 if e7<e25 and e25<e99 else 0))
        else:f.append(0)
    # 位置分位: 当前价在近60根的位置
    w=c[-60:];hi=max(w);lo2=min(w)
    f.append((p-lo2)/((hi-lo2) or 1)*100)
    return f
def main():
    days=int(sys.argv[1]) if len(sys.argv)>1 else 30
    fp=f'{DATA_DIR}/btc_1m_{days}d.csv'
    if os.path.exists(fp):
        rows=[tuple(map(float,x.strip().split(","))) for x in open(fp) if x.strip()][-100000:]
        print(f"📂缓存 {len(rows)}根")
    else:
        print(f"⬇️拉取{days}天1m...")
        rows=fetch_1m(days)
        open(fp,'w').write("\n".join(f"{int(r[0])},{r[1]},{r[2]},{r[3]},{r[4]}" for r in rows))
        print(f"✅拉取{len(rows)}根")
    N=10;X=[];y=[];ts=[]
    for i in range(len(rows)-N):
        f=tech_feats(rows,i)
        if f is None:continue
        p0=rows[i][1];p10=rows[i+N][1]
        lb=1 if p10>p0 else (-1 if p10<p0 else 0)
        if lb==0:continue
        X.append(f);y.append(lb);ts.append(i)
    X=np.array(X);y=np.array(y)
    print(f"样本:{len(X)} 涨{(y==1).sum()} 跌{(y==-1).sum()}")
    split=int(len(X)*0.7)
    Xtr,Xte,ytr,yte=X[:split],X[split:],y[:split],y[split:]
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
    from sklearn.model_selection import cross_val_score
    # 集成: RF + GBDT, 选50%特征行bag
    rng=np.random.RandomState(0)
    m=len(Xtr);sel=rng.choice(m,m,replace=True)
    rf=RandomForestClassifier(n_estimators=300,max_depth=10,random_state=42,n_jobs=-1).fit(Xtr[sel],ytr[sel])
    gb=GradientBoostingClassifier(n_estimators=200,max_depth=5,random_state=42).fit(Xtr,ytr)
    prf=rf.predict_proba(Xte);pgb=gb.predict_proba(Xte)
    # 集成概率平均
    pprob=(prf+pgb)/2
    probs_up=pprob[:,1]; # 涨概率
    # 方向: prob_up>0.5多, <0.5空
    pred=np.where(probs_up>0.5,1,-1)
    acc=(pred==yte).mean()
    # 分方向
    longm=(pred==1); upwin=((yte[longm]==1).sum(),longm.sum())
    shortm=(pred==-1); downwin=((yte[shortm]==-1).sum(),shortm.sum())
    # 置信度过滤: |prob_up-0.5|>thr 才交易
    for thr in [0.03,0.05,0.08,0.10,0.15]:
        conf=np.abs(probs_up-0.5)>thr
        if conf.sum()>0:
            accc=((pred[conf]==yte[conf]).sum()/conf.sum())
            print(f"  置信度>±{thr}: 样本{conf.sum()} 胜率{accc*100:.1f}%")
    print(f"\n整体胜率: {acc*100:.1f}%")
    print(f"做多胜率: {upwin[0]*100/max(upwin[1],1):.1f}% ({upwin[1]}笔)")
    print(f"做空胜率: {downwin[0]*100/max(downwin[1],1):.1f}% ({downwin[1]}笔)")
    print(f"⚠️目标≥60%才实盘")
main()
