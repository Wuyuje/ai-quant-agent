#!/usr/bin/env python3
"""移动止盈止损模式对比 - 找出"盈利才平仓,亏损不随便单平"的最优
模式A(当前): 止损-1%(遇亏也平), 盈吐-0.5%
模式B: 盈利>0才移动止盈(回吐0.5%), 亏损用宽松止损-5%+时间兜底
模式C: 盈利>0才移动止盈, 亏损不平(仅极端-20%+时间兜底)
杠杆5x, 6币
"""
import urllib.request,json,time,math,sys
sys.path.insert(0,'/app/workspace/ai-quant-agent')
UA={'User-Agent':'Mozilla/5.0'}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','LINKUSDT']
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
            u=u if(u<up[i-1]or c[i-1]>up[i-1])else up[i-1]
            dd=dd if(dd>dn[i-1]or c[i-1]<dn[i-1])else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    return d
def run_mode(kl,mode,trail,sl_loose,sl_tight,timeN):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c);trd=[];pos=0;entry=0;peak=0;ei=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i];ei=i;peak=0
        else:
            cur_roi=((c[i]-entry)/entry)*LEV*pos
            hi_roi=((h[i]-entry)/entry)*LEV*pos
            lo_roi=((l[i]-entry)/entry)*LEV*pos
            # 更新峰值
            if pos==1 and hi_roi>peak: peak=hi_roi
            if pos==-1 and lo_roi>peak: peak=lo_roi
            hit_trail=peak>0 and cur_roi<=peak-trail
            hit_sl=False
            hit_time=(i-ei)>=timeN
            if mode=='A':
                # 止损-1%(遇亏也平)
                if pos==1 and lo_roi<=-sl_tight: hit_sl=True
                if pos==-1 and hi_roi<=-sl_tight: hit_sl=True
            elif mode=='B':
                # 亏损宽松: -5%才止损
                if pos==1 and lo_roi<=-sl_loose: hit_sl=True
                if pos==-1 and hi_roi<=-sl_loose: hit_sl=True
            elif mode=='C':
                # 亏损不平, 仅极端-20%
                if pos==1 and lo_roi<=-0.20: hit_sl=True
                if pos==-1 and hi_roi<=-0.20: hit_sl=True
            if hit_sl: trd.append(-abs(sl_tight)*100 if mode=='A' else -abs(sl_loose)*100 if mode=='B' else -20.0);pos=0
            elif hit_trail: trd.append(cur_roi*100);pos=0
            elif hit_time: trd.append(cur_roi*100);pos=0
            elif d[i]!=d[i-1]: trd.append(cur_roi*100);pos=0
    if pos!=0:trd.append(((c[-1]-entry)/entry)*LEV*100*pos)
    if len(trd)<15:return None
    wins=[x for x in trd if x>0]
    return {'acc':len(wins)/len(trd)*100,'n':len(trd),'net':sum(trd)}
modes=[
    ('A:止损-1%/盈吐0.5%',lambda k:run_mode(k,'A',0.005,0.05,0.01,240)),
    ('B:损-5%/盈吐0.5%',lambda k:run_mode(k,'B',0.005,0.05,0.01,240)),
    ('B2:损-5%/盈吐1%',lambda k:run_mode(k,'B',0.010,0.05,0.01,240)),
    ('C:损-20%/盈吐0.5%',lambda k:run_mode(k,'C',0.005,0.20,0.01,240)),
    ('C2:损-20%/盈吐1%',lambda k:run_mode(k,'C',0.010,0.20,0.01,240)),
    ('B3:损-5%/盈吐0.8%',lambda k:run_mode(k,'B',0.008,0.05,0.01,240)),
]
print(f"杠杆{LEV}x",flush=True)
print(f"{'币':<9}"+''.join(f"  {n[:9]}" for n,_ in modes),flush=True)
nm=[[] for _ in modes]
for sym in POOL:
    try: kl=fetch(sym)
    except: continue
    line=f"  {sym[:7]}"
    for si,(_,fn) in enumerate(modes):
        r=fn(kl)
        if r: nm[si].append(r['net']);line+=f"  {r['acc']:3.0f}%/{r['net']:+5.1f}%".replace('%','%',1)
        else: line+="   --/--"
    print(line,flush=True)
print("\n=== 各模式平均净回报 ===",flush=True)
for si,(name,_) in enumerate(modes):
    a=nm[si]
    if a: print(f"  {name:<20}: 平均净{sum(a)/len(a):+.1f}%  盈利{sum(1 for x in a if x>0)}/{len(a)}币",flush=True)
