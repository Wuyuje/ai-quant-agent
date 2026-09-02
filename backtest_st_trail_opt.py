#!/usr/bin/env python3
"""移动回报率止盈 - 回撤阈值最优扫描
逻辑(移动止盈): 回报率创新高→拿着; 从峰值回撤达TRAIL%→止盈
激活: 只要进入盈利(峰值>0)即开始跟踪(最小激活)
止损: 回报率-15%
杠杆5x. 扫回撤 2/3/4/5/6/7/8/10%
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
def run(kl,trail,sl_roi=0.15):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c);trades=[];pos=0;entry=0;peak_roi=0;ei=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i];ei=i;peak_roi=0
        else:
            hi_roi=((h[i]-entry)/entry)*LEV*pos
            cur_roi=((c[i]-entry)/entry)*LEV*pos
            # 更新峰值回报(仅正向)
            if pos==1 and hi_roi>peak_roi: peak_roi=hi_roi
            if pos==-1 and hi_roi>peak_roi: peak_roi=hi_roi  # 空单也跟踪正向峰值
            # 止损(回报-15%)
            hit_sl=(((entry-l[i])/entry)*LEV>=sl_roi and pos==1) or (((h[i]-entry)/entry)*LEV>=sl_roi and pos==-1)
            # 移动止盈: 有盈利峰值(peak>0) 且 回撤达trail
            hit_trail = peak_roi>0 and cur_roi<=peak_roi-trail
            # 时间兜底
            hit_time=(i-ei)>=240
            if hit_sl: trades.append(-sl_roi*100);pos=0
            elif hit_trail: trades.append(cur_roi*100);pos=0
            elif hit_time: trades.append(cur_roi*100);pos=0
            elif d[i]!=d[i-1]: trades.append(cur_roi*100);pos=0
    if pos!=0:trades.append(((c[-1]-entry)/entry)*LEV*100*pos)
    if len(trades)<12:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
trails=[0.02,0.03,0.04,0.05,0.06,0.07,0.08,0.10]
print(f"杠杆{LEV}x, 移动止盈(峰值回撤), 止损-15%",flush=True)
print(f"{'币':<9}"+''.join(f"  {('回'+str(int(t*100))+'%'):>6}" for t in trails),flush=True)
netmap=[[] for _ in trails]
for sym in POOL:
    try: kl=fetch(sym)
    except: continue
    line=f"  {sym[:7]}"
    for si,t in enumerate(trails):
        r=run(kl,t)
        if r: netmap[si].append(r['net']);line+=f"  {r['acc']:3.0f}%/{r['net']:+5.1f}%".replace('%','%',1)
        else: line+="   --/--"
    print(line,flush=True)
print("\n=== 各回撤阈值平均净回报(ROI%) ===",flush=True)
best=None
for si,t in enumerate(trails):
    arr=netmap[si]
    if arr:
        avg=sum(arr)/len(arr);pn=sum(1 for x in arr if x>0)
        print(f"  回撤{int(t*100)}%: 平均净{avg:+.1f}%  盈利币{pn}/{len(arr)}",flush=True)
        if best is None or avg>best[1]:best=(int(t*100),avg,pn,len(arr))
if best:print(f"\n🏆 最优: 回撤{best[0]}% (平均净{best[1]:+.1f}%, {best[2]}/{best[3]}币盈利)",flush=True)
