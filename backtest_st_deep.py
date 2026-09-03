#!/usr/bin/env python3
"""震荡策略深度研究 - 系统性对比入场方向×出场方式
入场: SUPER翻转点
  dir方向: +1上涨(红), -1下跌(绿)
  A顺势: 转上涨(+1)做多 / 转下跌(-1)做空
  B反转: 转上涨(+1)做空 / 转下跌(-1)做多
出场:
  方式1: 固定%止盈止损 (SL%/TP%)
  方式2: 移动止盈(盈利达act%后回撤trail%平) + 固定止损SL%
  方式3: 时间出场N根 + 固定止损SL%
  方式4: 无固定(靠下一次翻转平)  ← 之前虚高的
多币验证 → 找净盈亏稳定为正+胜率高的
"""
import urllib.request,json,time,math

UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='5m',limit=3000):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.35);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.8)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in all_k]
def supertrend(h,l,c,p=10,m=3.0):
    n=len(c);atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]));atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)];up=[0.0]*n;dn=[0.0]*n;d=[1]*n
    for i in range(n):
        u=hl2[i]+m*atr[i];dd=hl2[i]-m*atr[i]
        if i>0:
            u=u if (u<up[i-1] or c[i-1]>up[i-1]) else up[i-1]
            dd=dd if (dd>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    return d

def run(kl,entry_dir,mode,sl,tp,act,trail,timeN):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c)
    trades=[];pos=0;entry=0;ei=0;peak=0
    for i in range(1,n-1):
        if pos==0:
            if d[i]!=d[i-1]:
                dd=d[i]
                if entry_dir=='顺势': pos=dd           # 转上涨做多/转下跌做空
                else: pos=-dd                          # 转上涨做空/转下跌做多
                entry=c[i];ei=i;peak=entry
        else:
            a=atr_temp(h,l,c,i)
            hi=h[i];lo=l[i]
            # 移动止盈跟踪峰值
            if pos==1: peak=max(peak,hi)
            else: peak=min(peak,lo)
            r_tp=r_sl=r_time=r_rev=None
            # 止损
            if pos==1 and lo<=entry*(1-sl): r_sl=sl
            elif pos==-1 and hi>=entry*(1+sl): r_sl=sl
            # 止盈
            if mode==1 and pos==1 and hi>=entry*(1+tp): r_tp=tp
            elif mode==1 and pos==-1 and lo<=entry*(1-tp): r_tp=tp
            # 移动止盈
            if mode==2:
                if pos==1 and (peak-entry)/entry>=act and hi>=peak*(1-trail): pass
                if pos==1 and (peak-entry)/entry>=act and lo<=peak*(1-trail): r_tp=(peak-entry)/entry
                if pos==-1 and (entry-peak)/entry>=act and hi>=peak*(1+trail): r_tp=(entry-peak)/entry
            # 时间出场
            if mode==3 and (i-ei)>=timeN:
                rr=((c[i]-entry)/entry)*pos;r_time=rr
            # 反转平(兜底)
            if d[i]!=d[i-1]:
                rr=((c[i]-entry)/entry)*pos;r_rev=rr
            if r_sl is not None: trades.append(-r_sl*100);pos=0
            elif r_tp is not None: trades.append(r_tp*100);pos=0
            elif r_time is not None: trades.append(r_time*100);pos=0
            elif r_rev is not None: trades.append(r_rev*100);pos=0
    if pos!=0: trades.append((((c[-1]-entry)/entry)*100)*pos)
    if len(trades)<10:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
def atr_temp(h,l,c,i,n=14):
    s=0
    for j in range(max(1,i-n+1),i+1): s+=max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1]))
    return s/min(abs(i-n+1)+1,n)
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','ADAUSDT','LINKUSDT','LTCUSDT']
# 测试矩阵
cases=[
    ('顺势','方式1固定%',0.012,0.015,0,0,0),
    ('顺势','方式2移动止损',0.012,0,0.008,0.006,0),
    ('顺势','方式3时间12根',0.012,0,0,0,12),
    ('反转','方式1固定%',0.012,0.015,0,0,0),
    ('反转','方式2移动',0.012,0,0.008,0.006,0),
    ('反转','方式3时间12根',0.012,0,0,0,12),
]
print(f"{'币':<9}{'策略':<18}{'胜率':>7}{'样本':>5}{'净盈亏%':>9}",flush=True)
netmap={c[1]:[] for c in cases}
for sym in POOL:
    kl=fetch(sym)
    for (ed,mode,sl,tp,act,trail,timeN,lab) in [(c[0],c[1],c[2],c[3],c[4],c[5],c[6],f"{c[0]}/{c[1]}") for c in cases]:
        r=run(kl,ed,mode,sl,tp,act,trail,timeN)
        if r: netmap[mode].append(r['acc'])
# 汇总各方式平均
print("\n=== 各方式平均胜率 ===",flush=True)
for k,v in netmap.items():
    if v: print(f"  {k:<16} 平均胜率{sum(v)/len(v):.1f}% ({len(v)}币)",flush=True)
