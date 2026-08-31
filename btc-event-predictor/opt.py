#!/usr/bin/env python3
"""搜索最优组合: 持仓分钟数N + 置信度阈值thr, 找胜率最高配置(30天数据)"""
import os,sys,math
import numpy as np
DATA_DIR=os.path.dirname(os.path.abspath(__file__))
def load():
    fp=f'{DATA_DIR}/btc_1m_30d.csv'
    if not os.path.exists(fp): 
        print("需先有30天数据缓存"); sys.exit(0)
    return [tuple(map(float,x.strip().split(","))) for x in open(fp) if x.strip()]
def ema(a,n):
    k=2/(n+1);e=a[0]
    for x in range(1,len(a)):e=a[x]*k+e*(1-k)
    return e
def feats(rows,i):
    if i<250:return None
    c=[r[1] for r in rows[:i+1]];h=[r[2] for r in rows[:i+1]];l=[r[3] for r in rows[:i+1]];v=[r[4] for r in rows[:i+1]]
    p=c[i];f=[]
    for n in [2,3,5,8,13,21]: f.append((p-c[i-n])/(c[i-n] or 1)*100)
    for nn in [7,14]:
        if i>=nn+1:
            g=l_=0
            for j in range(i-nn+1,i+1):
                d=c[j]-c[j-1]
                if d>0:g+=d
                else:l_-=d
            f.append(100-100/(1+(g/l_ if l_>0 else 99)))
        else:f.append(50)
    seg=c[i-20:i];m=sum(seg)/20;sd=math.sqrt(sum((x-m)**2 for x in seg)/20)
    up=m+2*sd;lo=m-2*sd
    f.append((p-lo)/((up-lo) or 1)*100);f.append((up-lo)/p*100)
    e12=ema(c[max(0,i-40):],12);e26=ema(c[max(0,i-40):],26)
    f.append((e12-e26)/p*100)
    if i>=14:
        trs=[max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])) for j in range(i-13,i+1)]
        f.append(sum(trs)/14/p*100)
    else:f.append(0)
    if i>=25:
        vn=sum(v[i-4:i+1])/5;vp=sum(v[i-24:i-4])/20
        f.append(vn/vp if vp>0 else 1)
    else:f.append(1)
    if i>=240:
        cw=c[-240:];e7=ema(cw,7);e25=ema(cw,25);e99=ema(cw,99)
        f.append(1 if e7>e25 and e25>e99 else (-1 if e7<e25 and e25<e99 else 0))
    else:f.append(0)
    w=c[-60:];hi=max(w);lo2=min(w)
    f.append((p-lo2)/((hi-lo2) or 1)*100)
    return f
rows=load()
print(f"数据{len(rows)}根, 构建特征...")
# 预建特征(用N=10时的特征, 但标签用不同N)
maxN=15
all_f=[];all_ts=[]
for i in range(len(rows)-maxN):
    f=feats(rows,i)
    if f: all_f.append(f); all_ts.append(i)
all_f=np.array(all_f)
print(f"特征样本{len(all_f)}")
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
# 用中间N训练一次模型(特征不含N,通用)
split=int(len(all_f)*0.7)
train_idx=all_ts[:split]; test_ts=all_ts[split:]
rf=RandomForestClassifier(n_estimators=250,max_depth=10,random_state=42,n_jobs=-1)
best=None
# 对每个N建标签&测
print(f"{'N分钟':<5} 整体胜率  |  置信度>±0.1 | ±0.15 | ±0.2 | ±0.25")
for N in [3,5,8,10,12,15]:
    ys=[]
    for i in all_ts[split:]:
        p0=rows[i][1];pN=rows[i+N][1]
        ys.append(1 if pN>p0 else (-1 if pN<p0 else 0))
    ys=np.array(ys);mask=ys!=0
    if mask.sum()<100:continue
    Xte=all_f[split:][mask]; yte=ys[mask]
    # 只用N匹配训练(简化:用全训练但标签用N)
    ytr=[]
    for i in all_ts[:split]:
        p0=rows[i][1];pN=rows[i+N][1]
        ytr.append(1 if pN>p0 else (-1 if pN<p0 else 0))
    ytr=np.array(ytr);m2=ytr!=0
    Xtr=all_f[:split][m2];ytr=ytr[m2]
    rf.fit(Xtr,ytr)
    proba=rf.predict_proba(Xte)[:,1]
    pred=np.where(proba>0.5,1,-1)
    acc=(pred==yte).mean()*100
    best_line=f"{N:<5} {acc:5.1f}%   "
    for thr in [0.1,0.15,0.2,0.25]:
        conf=np.abs(proba-0.5)>thr
        accc=((pred[conf]==yte[conf]).sum()/max(conf.sum(),1))*100 if conf.sum()>0 else 0
        best_line+=f"| {accc:4.1f}% "
    print(best_line)
