#!/usr/bin/env python3
"""BOLL_PREFERRED 14币完整回测 SuperTrend反转(SL1%/TP1.5%) - 找出弱币排除"""
import urllib.request,json,time,math,sys
sys.path.insert(0,'/app/workspace/ai-quant-agent')
UA={'User-Agent':'Mozilla/5.0'}
POOL=['DOGEUSDT','ADAUSDT','INJUSDT','IMXUSDT','SUIUSDT','ARBUSDT','DOTUSDT','XRPUSDT','ETHUSDT','SOLUSDT','LTCUSDT','APTUSDT','SEIUSDT','LINKUSDT']
def fetch(sym,interval='5m',limit=2500):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.35);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.6)
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
def run(kl,sl=0.010,tp=0.015):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c);trades=[];pos=0;entry=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i]
        else:
            hit_tp=(h[i]>=entry*(1+tp) and pos==1) or (l[i]<=entry*(1-tp) and pos==-1)
            hit_sl=(l[i]<=entry*(1-sl) and pos==1) or (h[i]>=entry*(1+sl) and pos==-1)
            if hit_sl: trades.append(-sl*100);pos=0
            elif hit_tp: trades.append(tp*100);pos=0
            elif d[i]!=d[i-1]: trades.append(((c[i]-entry)/entry)*100*pos);pos=0
    if pos!=0:trades.append(((c[-1]-entry)/entry)*100*pos)
    if len(trades)<12:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
print(f"{'币':<10}{'胜率':>7}{'样本':>5}{'净盈亏%':>9}  判定",flush=True)
strong=[];weak=[]
for sym in POOL:
    try: kl=fetch(sym)
    except: print(f"  {sym:<8} 拉取失败",flush=True);continue
    r=run(kl)
    if r:
        verdict='✅强' if r['net']>0 else '❌弱'
        if r['net']>0: strong.append(sym)
        else: weak.append(sym)
        print(f"  {sym:<8}{r['acc']:6.1f}%  {r['n']:>4}  {r['net']:8.2f}  {verdict}",flush=True)
    else: print(f"  {sym:<8} 样本不足",flush=True)
print(f"\n=== 结果 ===",flush=True)
print(f"强币({len(strong)}): {','.join(strong)}",flush=True)
print(f"弱币({len(weak)}): {','.join(weak)}",flush=True)
