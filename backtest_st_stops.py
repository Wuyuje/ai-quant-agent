#!/usr/bin/env python3
"""SuperTrend反转 + 止损收紧回测
目标: 找止损收紧到多少(0.4%~1.2%)配合止盈, 能控制单笔亏损且整体盈利
入场: SUPER(10,3)翻转点反转开仓
出场: 逐K高低点判定 主动止损(SL%) + 主动止盈(TP%)
关键: 止损收紧 = 单笔亏损可控, 不扛单深亏
"""
import urllib.request,json,time,math,sys
sys.path.insert(0,'/app/workspace/ai-quant-agent')
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='5m',limit=3000):
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
def run(kl,sl_pct,tp_pct):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c)
    trades=[];pos=0;entry=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i]
        else:
            hit_tp=False;hit_sl=False
            if pos==1:
                if h[i]>=entry*(1+tp_pct): hit_tp=True
                if l[i]<=entry*(1-sl_pct): hit_sl=True
            else:
                if l[i]<=entry*(1-tp_pct): hit_tp=True
                if h[i]>=entry*(1+sl_pct): hit_sl=True
            # 同K先触止损(保守: 亏损优先)
            if hit_sl: trades.append(-sl_pct*100);pos=0
            elif hit_tp: trades.append(tp_pct*100);pos=0
            elif d[i]!=d[i-1]:
                rr=((c[i]-entry)/entry)*pos*100;trades.append(rr);pos=0
    if pos!=0: trades.append((((c[-1]-entry)/entry)*100)*pos)
    if len(trades)<15:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades),'worst':min(trades)}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','ADAUSDT','LINKUSDT','LTCUSDT','SUIUSDT','ARBUSDT']
# 测试组合: 止损收紧 0.4/0.6/0.8/1.0, 止盈搭配
combos=[
    (0.004,0.008),(0.004,0.010),(0.006,0.010),(0.006,0.012),
    (0.008,0.012),(0.008,0.014),(0.010,0.015),(0.010,0.012),
]
print(f"{'币':<9}"+''.join(f"  S{c[0]*100:.1f}/T{c[1]*100:.1f}" for c in combos),flush=True)
netmap=[[] for _ in combos]
worst_total={}
for sym in POOL:
    try: kl=fetch(sym)
    except: continue
    line=f"  {sym[:7]}"
    for si,(sl,tp) in enumerate(combos):
        r=run(kl,sl,tp)
        if r:
            netmap[si].append(r['net'])
            line+=f"  {r['acc']:4.0f}%/{r['net']:+5.1f}%".replace('%','%',1)
        else: line+="   --/--"
    print(line+'',flush=True)
print("\n=== 各止损组合平均净盈亏 ===",flush=True)
for si,(sl,tp) in enumerate(combos):
    arr=netmap[si]
    if arr:
        pos_n=sum(1 for x in arr if x>0)
        print(f"  止损{sl*100:.1f}%/止盈{tp*100:.1f}%: 平均净{sum(arr)/len(arr):+.2f}%  {pos_n}/{len(arr)}币盈利",flush=True)
