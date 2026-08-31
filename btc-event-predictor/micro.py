#!/usr/bin/env python3
"""BTC 10分钟预测- 毫秒级(1s)微观结构算法
用过去5分钟(300个1s点)的秒级微观序列预测未来10分钟涨跌
特征: 秒级方向/成交失衡/波动结构/路径形态/时序统计
"""
import urllib.request,json,time,os,sys,math,datetime
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
DATA_DIR=os.path.dirname(os.path.abspath(__file__))
def fetch_1s(minutes):
    """拉取1s K线覆盖指定分钟数(分页,每1000根=16.7分)"""
    all_k=[];end=None;need=minutes*60
    while len(all_k)<need:
        url='https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=1000'
        if end:url+=f'&endTime={end}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=15).read())
        except:time.sleep(0.3);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.06)
        if len(b)<1000:break
    all_k.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[4]),float(x[1]),float(x[3]),float(x[5])) for x in all_k]
def micro_feats(secs_past):
    """secs_past: [(ts,close)] 过去一段的1s序列, 构造微观特征"""
    c=[x[1] for x in secs_past]
    h=[x[2] for x in secs_past];l=[x[3] for x in secs_past];v=[x[4] for x in secs_past]
    if len(c)<60:return None
    f=[]
    # 1. 秒级方向统计: 涨/跌秒占比, 净方向
    ups=sum(1 for i in range(1,len(c)) if c[i]>c[i-1]); dns=len(c)-1-ups
    f.append(ups/(len(c)-1)); f.append((ups-dns)/(len(c)-1))
    # 2. 买卖成交失衡(volume&方向近似: 阳线数)
    upv=sum(v[i] for i in range(1,len(c)) if c[i]>c[i-1])
    f.append(upv/(sum(v[1:]) or 1))
    # 3. 波动结构: 最近N段每段的涨跌, 波动率序列
    win=60; f.append((c[-1]-c[-win])/(c[-win] or 1)*100)  # 近60秒涨跌
    # 每5秒一段的涨跌(最近24段*5s=2分钟)
    segs=[]
    for s in range(0,min(150,len(c)-1),5):
        segs.append((c[s+5]-c[s])/(c[s] or 1)*100 if s+5<len(c) else 0)
    f.append(sum(segs)/max(len(segs),1))
    f.append(max(segs) if segs else 0); f.append(min(segs) if segs else 0)
    f.append(sum(1 for x in segs if x>0)/max(len(segs),1))
    # 4. 价格路径形态(累积/涌现)
    ret_total=(c[-1]-c[0])/(c[0] or 1)*100
    f.append(ret_total)
    # 5. 高/低价位置
    hi=max(c[-60:]);lo=min(c[-60:])
    f.append((c[-1]-lo)/((hi-lo) or 1)*100)
    # 6. 量能趋势
    if len(v)>=30:
        f.append(sum(v[-10:])/(sum(v[-30:]) or 1))
    else:f.append(1)
    # 7. ATR秒级
    trs=[max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1])) for i in range(1,len(c))]
    f.append(sum(trs[-60:])/60/(c[-1] or 1)*100)
    return f
def main():
    minutes=int(sys.argv[1]) if len(sys.argv)>1 else 30
    fp=f'{DATA_DIR}/btc_1s_{minutes}m.csv'
    if os.path.exists(fp):
        rows=[tuple(map(float,x.strip().split(","))) for x in open(fp) if x.strip()]
        print(f"📂秒级缓存: {len(rows)}个1s点")
    else:
        print(f"⬇️拉取{minutes}分钟1s数据...")
        rows=fetch_1s(minutes)
        open(fp,'w').write("\n".join(f"{int(r[0])},{r[1]},{r[2]},{r[3]},{r[4]}" for r in rows))
        print(f"✅拉取{len(rows)}个1s点")
    # 构建样本: 用过去5分钟(300s)预测未来10分钟(600s)
    LOOKBACK=300; HORIZON=600
    X=[];y=[];ts=[]
    for i in range(LOOKBACK, len(rows)-HORIZON, 5):  # 每5秒采样一个样本
        past=rows[i-LOOKBACK:i+1]
        f=micro_feats(past)
        if f is None:continue
        p0=rows[i][1]; p_h=rows[i+HORIZON][1]
        lb=1 if p_h>p0 else (-1 if p_h<p0 else 0)
        if lb==0:continue
        X.append(f);y.append(lb);ts.append(i)
    if len(X)<1000:
        print(f"⚠️秒级样本不足{len(X)}, 数据需更长"); return
    from sklearn.ensemble import RandomForestClassifier,GradientBoostingClassifier
    X=np.array(X);y=np.array(y)
    print(f"秒级样本:{len(X)} 涨{(y==1).sum()} 跌{(y==-1).sum()}")
    split=int(len(X)*0.7)
    Xtr,Xte,ytr,yte=X[:split],X[split:],y[:split],y[split:]
    rf=RandomForestClassifier(n_estimators=300,max_depth=12,random_state=42,n_jobs=-1).fit(Xtr,ytr)
    gb=GradientBoostingClassifier(n_estimators=200,max_depth=5,random_state=42).fit(Xtr,ytr)
    prf=rf.predict_proba(Xte);pgb=gb.predict_proba(Xte)
    pprob=(prf+pgb)/2
    proba_up=pprob[:,1]
    pred=np.where(proba_up>0.5,1,-1)
    acc=(pred==yte).mean()*100
    lm=(pred==1);sm=(pred==-1)
    la=((yte[lm]==1).sum()/max(lm.sum(),1))*100
    sa=((yte[sm]==-1).sum()/max(sm.sum(),1))*100
    print(f"\n═══ BTC 10分钟预测(1s毫秒级微观算法) ═══")
    print(f"整体胜率: {acc:.1f}%")
    print(f"做多胜率: {la:.1f}% ({lm.sum()}笔)")
    print(f"做空胜率: {sa:.1f}% ({sm.sum()}笔)")
    for thr in [0.1,0.15,0.2]:
        conf=np.abs(proba_up-0.5)>thr
        if conf.sum()>0:
            accc=((pred[conf]==yte[conf]).sum()/conf.sum())*100
            print(f"置信度>±{thr}: 胜率{accc:.1f}% ({conf.sum()}笔)")
    print(f"⚠️目标≥60%才实盘")
main()
