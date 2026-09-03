#!/usr/bin/env python3
"""移动回报率止盈 最优参数回测
移动止盈(回报率): 盈利回报达MOVE_ACT%后, 从最高回报回撤TRAIL%平
止损: 回报率SL_%
杠杆约束: 回报率=价格%×LEV. 用LEV=5基准
对比: 固定回报率15%/15% (之前的基准)
找: 移动回报率策略更优?
"""
import urllib.request,json,time,math,sys
sys.path.insert(0,'/app/workspace/ai-quant-agent')
UA={'User-Agent':'Mozilla/5.0'}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','LINKUSDT','INJUSDT','DOTUSDT','APTUSDT']
LEV=5
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
def run_trail_roi(kl,sl_roi,move_act,trail,timeN=240):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c)
    trades=[];pos=0;entry=0;peak=0;peak_roi=0;ei=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i];ei=i;peak_roi=0
        else:
            # 当前回报率
            hi_roi=((h[i]-entry)/entry)*LEV*pos
            lo_roi=((l[i]-entry)/entry)*LEV*pos
            # 更新峰值回报
            if pos==1: peak_roi=max(peak_roi,hi_roi)
            else: peak_roi=max(peak_roi,lo_roi)
            cur_roi=((c[i]-entry)/entry)*LEV*pos
            # 止损
            hit_sl=((entry-l[i])/entry*LEV>=sl_roi and pos==1) or ((h[i]-entry)/entry*LEV>=sl_roi and pos==-1)
            # 移动止盈: 激活后 当前回报 <= 峰值回报-回撤
            hit_trail = peak_roi>=move_act and cur_roi<=peak_roi-trail
            # 时间兜底
            hit_time=(i-ei)>=timeN
            if hit_sl: trades.append(-sl_roi*100);pos=0
            elif hit_trail: trades.append(cur_roi*100);pos=0
            elif hit_time: trades.append(cur_roi*100);pos=0
            elif d[i]!=d[i-1]: trades.append(cur_roi*100);pos=0
    if pos!=0:trades.append(((c[-1]-entry)/entry)*LEV*100*pos)
    if len(trades)<12:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
def run_fix_roi(kl,tp_roi,sl_roi):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c);trades=[];pos=0;entry=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i]
        else:
            hit_tp=((h[i]-entry)/entry*LEV>=tp_roi and pos==1) or ((entry-l[i])/entry*LEV>=tp_roi and pos==-1)
            hit_sl=((entry-l[i])/entry*LEV>=sl_roi and pos==1) or ((h[i]-entry)/entry*LEV>=sl_roi and pos==-1)
            if hit_sl: trades.append(-sl_roi*100);pos=0
            elif hit_tp: trades.append(tp_roi*100);pos=0
            elif d[i]!=d[i-1]: trades.append(((c[i]-entry)/entry)*LEV*100*pos);pos=0
    if pos!=0:trades.append(((c[-1]-entry)/entry)*LEV*100*pos)
    if len(trades)<12:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
# 配置 (名称, 函数)
confs=[
    ('固定T15/S15',lambda kl:run_fix_roi(kl,0.15,0.15)),
    ('移动 act8/回2',lambda kl:run_trail_roi(kl,0.15,0.08,0.02)),
    ('移动 act8/回3',lambda kl:run_trail_roi(kl,0.15,0.08,0.03)),
    ('移动 act10/回3',lambda kl:run_trail_roi(kl,0.15,0.10,0.03)),
    ('移动 act10/回4',lambda kl:run_trail_roi(kl,0.15,0.10,0.04)),
    ('移动 act12/回4',lambda kl:run_trail_roi(kl,0.15,0.12,0.04)),
    ('移动 act10/回5',lambda kl:run_trail_roi(kl,0.15,0.10,0.05)),
    ('移动 act15/回5',lambda kl:run_trail_roi(kl,0.15,0.15,0.05)),
]
print(f"杠杆{LEV}x, 回报率口径",flush=True)
print(f"{'币':<9}"+''.join(f"  {name[:8]}" for name,_ in confs),flush=True)
netmap=[[] for _ in confs]
for sym in POOL:
    try: kl=fetch(sym)
    except: continue
    line=f"  {sym[:7]}"
    for si,(_,fn) in enumerate(confs):
        r=fn(kl)
        if r: netmap[si].append(r['net']);line+=f"  {r['acc']:3.0f}%/{r['net']:+5.1f}%".replace('%','%',1)
        else: line+="   --/--"
    print(line,flush=True)
print("\n=== 各移动回报率组合平均净回报(ROI%) ===",flush=True)
best=None
for si,(name,_) in enumerate(confs):
    arr=netmap[si]
    if arr:
        avg=sum(arr)/len(arr);pn=sum(1 for x in arr if x>0)
        print(f"  {name:<16}: 平均净{avg:+.1f}%  盈利币{pn}/{len(arr)}",flush=True)
        if best is None or avg>best[1]:best=(name,avg,pn,len(arr))
if best:print(f"\n🏆 最优: {best[0]} (平均净{best[1]:+.1f}%, {best[2]}/{best[3]}币盈利)",flush=True)
