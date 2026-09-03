#!/usr/bin/env python3
"""回报率止盈止损 最优阈值回测
说明: 回报率 = 价格% × 杠杆. 用5x基准杠杆回测(回报率/5=价格%)
止盈止损按回报率判定, 找最优 TP_ROI(回报%) / SL_ROI(回报%)
测试盈亏比组合 -> 找出净盈亏最高
"""
import urllib.request,json,time,math,sys
sys.path.insert(0,'/app/workspace/ai-quant-agent')
UA={'User-Agent':'Mozilla/5.0'}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','LINKUSDT','INJUSDT','DOTUSDT','APTUSDT']  # 之前的强币
LEV=5  # 基准杠杆
def fetch(sym,interval='5m',limit=3000):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.35);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.5)
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
def run(kl,tp_roi,sl_roi):
    """止盈止损按回报率: 价格变动%×LEV 达回报阈值触发"""
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c);trades=[];pos=0;entry=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i]
        else:
            # 回报率判定 (价格%×杠杆)
            hit_tp=((h[i]-entry)/entry*LEV>=tp_roi and pos==1) or ((entry-l[i])/entry*LEV>=tp_roi and pos==-1)
            hit_sl=((entry-l[i])/entry*LEV>=sl_roi and pos==1) or ((h[i]-entry)/entry*LEV>=sl_roi and pos==-1)
            if hit_sl: trades.append(-sl_roi*100);pos=0
            elif hit_tp: trades.append(tp_roi*100);pos=0
            elif d[i]!=d[i-1]: trades.append(((c[i]-entry)/entry)*LEV*100*pos);pos=0
    if pos!=0:trades.append(((c[-1]-entry)/entry)*LEV*100*pos)
    if len(trades)<12:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
# 回报率组合 (止盈ROI%, 止损ROI%)
combos=[
    (10,10),(15,10),(20,10),(15,8),(20,12),(15,15),(20,15),(12,8),(25,10),
]
print(f"杠杆基准:{LEV}x (回报率=价格%×{LEV})",flush=True)
print(f"{'币':<9}"+''.join(f"  T{c[0]}/S{c[1]}" for c in combos),flush=True)
netmap=[[] for _ in combos]
for sym in POOL:
    try: kl=fetch(sym)
    except: continue
    line=f"  {sym[:7]}"
    for si,(tp,sl) in enumerate(combos):
        r=run(kl,tp/100,sl/100)
        if r: netmap[si].append(r['net']);line+=f"  {r['acc']:3.0f}%/{r['net']:+5.1f}%".replace('%','%',1)
        else: line+="   --/--"
    print(line,flush=True)
print("\n=== 各回报率组合平均净回报(ROI%) ===",flush=True)
best=None
for si,(tp,sl) in enumerate(combos):
    arr=netmap[si]
    if arr:
        avg=sum(arr)/len(arr);pos_n=sum(1 for x in arr if x>0)
        tag=f"T{tp}/S{sl}"
        print(f"  止盈{tp}%/止损{sl}%: 平均净{avg:+.1f}%  盈利币{pos_n}/{len(arr)}",flush=True)
        if best is None or avg>best[1]: best=(tag,avg,pos_n,len(arr))
if best: print(f"\n🏆 最优: {best[0]} (平均净{best[1]:+.1f}%, {best[2]}/{best[3]}币盈利)",flush=True)
