#!/usr/bin/env python3
"""BTC 10分钟预测 毫秒级(1s)长时间回测 - 安全限速+缓存
安全策略: 公开接口 data-api.binance.vision, 每批间隔3秒, 分批拉并缓存
回测: 过去5分钟(300s)秒级微观特征 → 预测未来10分钟(600s)涨跌
"""
import urllib.request,json,time,os,sys,math,datetime
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
DATA_DIR=os.path.dirname(os.path.abspath(__file__))
fp=f'{DATA_DIR}/btc_1s_long.csv'
def fetch_1s_all():
    """安全分批拉取1s数据(每批3秒), 拉到最老即停, 缓存"""
    all_k=[];end=None
    print("⬇️ 安全分批拉取1s数据(每批间隔3秒)...",flush=True)
    while True:
        url='https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=1000'
        if end:url+=f'&endTime={end}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=15).read())
        except Exception as e:
            print("⚠️ 请求失败(可能限流),停拉:",str(e)[:50],flush=True);break
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1)
        time.sleep(3)  # 安全限速
        if len(all_k)%10000==0:print(f"  已拉{len(all_k)}个1s,最早{datetime.datetime.fromtimestamp(all_k[0][0]/1000)}",flush=True)
        if len(b)<1000:break
    all_k.sort(key=lambda x:x[0])
    rows=[(int(x[0]),float(x[4]),float(x[2]),float(x[3]),float(x[5])) for x in all_k]
    open(fp,'w').write("\n".join(f"{r[0]},{r[1]},{r[2]},{r[3]},{r[4]}" for r in rows))
    print(f"✅缓存{len(rows)}个1s点",flush=True)
    return rows
def load():
    if os.path.exists(fp):
        rows=[tuple(map(float,x.strip().split(","))) for x in open(fp) if x.strip()]
        return rows
    return fetch_1s_all()
def micro_feats(secs):
    c=[x[1] for x in secs];h=[x[2] for x in secs];l=[x[3] for x in secs];v=[x[4] for x in secs]
    if len(c)<60:return None
    f=[]
    ups=sum(1 for i in range(1,len(c)) if c[i]>c[i-1]);dns=len(c)-1-ups
    f.append(ups/(len(c)-1));f.append((ups-dns)/(len(c)-1))
    upv=sum(v[i] for i in range(1,len(c)) if c[i]>c[i-1])
    f.append(upv/(sum(v[1:]) or 1))
    win=60;f.append((c[-1]-c[-win])/(c[-win] or 1)*100)
    segs=[]
    for s in range(0,min(150,len(c)-1),5):
        segs.append((c[s+5]-c[s])/(c[s] or 1)*100 if s+5<len(c) else 0)
    f.append(sum(segs)/max(len(segs),1));f.append(max(segs) if segs else 0);f.append(min(segs) if segs else 0)
    f.append(sum(1 for x in segs if x>0)/max(len(segs),1))
    f.append((c[-1]-c[0])/(c[0] or 1)*100)
    hi=max(c[-60:]);lo=min(c[-60:])
    f.append((c[-1]-lo)/((hi-lo) or 1)*100)
    if len(v)>=30:f.append(sum(v[-10:])/(sum(v[-30:]) or 1))
    else:f.append(1)
    trs=[max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1])) for i in range(1,len(c))]
    f.append(sum(trs[-60:])/60/(c[-1] or 1)*100)
    return f
def main():
    rows=load()
    if len(rows)<5000: print(f"⚠️数据不足{len(rows)}"); return
    print(f"总1s点数:{len(rows)} ({len(rows)/3600:.1f}小时)",flush=True)
    LOOKBACK=300;HORIZON=600
    X=[];y=[];ts=[]
    for i in range(LOOKBACK,len(rows)-HORIZON,5):
        f=micro_feats(rows[i-LOOKBACK:i+1])
        if f is None:continue
        p0=rows[i][1];ph=rows[i+HORIZON][1]
        lb=1 if ph>p0 else(-1 if ph<p0 else 0)
        if lb==0:continue
        X.append(f);y.append(lb);ts.append(i)
    if len(X)<2000:print(f"⚠️样本不足{len(X)}");return
    from sklearn.ensemble import RandomForestClassifier,GradientBoostingClassifier
    X=np.array(X);y=np.array(y)
    print(f"样本:{len(X)} ({len(X)*5/3600:.1f}小时覆盖) 涨{(y==1).sum()}跌{(y==-1).sum()}",flush=True)
    split=int(len(X)*0.7)
    Xtr,Xte,ytr,yte=X[:split],X[split:],y[:split],y[split:]
    rf=RandomForestClassifier(n_estimators=300,max_depth=12,random_state=42,n_jobs=-1).fit(Xtr,ytr)
    gb=GradientBoostingClassifier(n_estimators=200,max_depth=5,random_state=42).fit(Xtr,ytr)
    pu=(rf.predict_proba(Xte)[:,1]+gb.predict_proba(Xte)[:,1])/2
    pred=np.where(pu>0.5,1,-1)
    acc=(pred==yte).mean()*100
    lm=(pred==1);sm=(pred==-1)
    la=((yte[lm]==1).sum()/max(lm.sum(),1))*100
    sa=((yte[sm]==-1).sum()/max(sm.sum(),1))*100
    print(f"\n═══ BTC10分钟 毫秒长时间回测({len(X)*5/3600:.1f}小时) ═══")
    print(f"整体: {acc:.1f}% | 做多:{la:.1f}%({lm.sum()}笔) | 做空:{sa:.1f}%({sm.sum()}笔)")
    for thr in [0.1,0.15,0.2,0.25]:
        conf=np.abs(pu-0.5)>thr
        if conf.sum()>0:print(f"置信度>±{thr}: 胜率{((pred[conf]==yte[conf]).sum()/conf.sum())*100:.1f}% ({conf.sum()}笔)")
    # 只做多高置信度(做多胜率远高)
    for thr in [0.05,0.1,0.15,0.2]:
        conf=(pred==1)&(pu>0.5+thr)
        if conf.sum()>0:print(f"仅做多&置信度的胜率: {((yte[conf]==1).sum()/conf.sum())*100:.1f}% ({conf.sum()}笔)")
main()
