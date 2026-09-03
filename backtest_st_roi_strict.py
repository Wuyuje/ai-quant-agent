#!/usr/bin/env python3
"""移动回报率止盈止损 严格回测 - 扫描最优回撤阈值×止损
机制(严格): 
  止损: 回报率跌破 -SL% 立即平(防扛单)
  移动止盈: 跟踪峰值回报(每K极端), 当前回报从峰值回撤达 TRAIL% 平
  时间兜底: 持仓超timeN根强平
杠杆5x. 覆盖多币, 找平均净回报最高且各币多为正
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
            u=u if(u<up[i-1]or c[i-1]>up[i-1])else up[i-1]
            dd=dd if(dd>dn[i-1]or c[i-1]<dn[i-1])else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    return d
def run(kl,sl,trail,timeN=240):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c);trd=[];pos=0;entry=0;peak=0;ei=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i];ei=i;peak=0
        else:
            # 当前K的回报极端值
            hi_roi=((h[i]-entry)/entry)*LEV*(1 if pos==1 else -1)
            lo_roi=((l[i]-entry)/entry)*LEV*(1 if pos==1 else -1)
            # 1) 止损优先: 反向极端达-SL
            hit_sl = (lo_roi<=-sl) if pos==1 else (hi_roi<=-sl)
            # 2) 峰值更新(正向极端)
            if pos==1:
                r_pos=((h[i]-entry)/entry)*LEV
            else:
                r_pos=((entry-l[i])/entry)*LEV
            if r_pos>peak: peak=r_pos
            # 3) 移动止盈: 有盈利峰值 且 当前收盘回撤达trail
            cur_roi=((c[i]-entry)/entry)*LEV*pos
            hit_trail = peak>0 and cur_roi<=peak-trail
            hit_time=(i-ei)>=timeN
            if hit_sl: trd.append(-sl*100);pos=0
            elif hit_trail: trd.append(cur_roi*100);pos=0
            elif hit_time: trd.append(cur_roi*100);pos=0
            elif d[i]!=d[i-1]: trd.append(cur_roi*100);pos=0
    if pos!=0: trd.append(((c[-1]-entry)/entry)*LEV*100*pos)
    if len(trd)<12:return None
    wins=[x for x in trd if x>0]
    return {'acc':len(wins)/len(trd)*100,'n':len(trd),'net':sum(trd)}
# 配置矩阵: 止损SL% × 移动回撤TRAIL%
configs=[(sl,tr) for sl in [0.05,0.08,0.10,0.15] for tr in [0.02,0.03,0.05,0.08]]
print(f"移动回报率止盈止损严格回测 (杠杆{LEV}x, 移动止盈=峰值回报回撤TRAIL%平, 止损=回报-SL%平)",flush=True)
for sl in [0.08,0.10,0.15]:
    print(f"\n=== 止损-{sl*100:.0f}% 组 ===",flush=True)
    print("币        "+"  ".join(f"回撤{tr*100:.0f}%:净/胜率" for sl2,tr in configs if sl2==sl),flush=True)
    nm=[[] for _ in configs if _[0]==sl]
    for sym in POOL:
        try: kl=fetch(sym)
        except: continue
        line=f"  {sym[:7]}   "
        idx=0
        for sl2,tr in configs:
            if sl2!=sl: continue
            r=run(kl,sl,tr)
            if r: nm[idx].append(r['net']); line+=f"{r['net']:+6.1f}%/{r['acc']:.0f}%  ".replace('%','%',1)
            else: line+="     --/--  "
            idx+=1
        print(line,flush=True)
    print("  平均:   "+"  ".join(f"{(sum(x)/len(x) if x else 0):+6.1f}%" for x in nm),flush=True)
print("\n=== 全配置平均净回报汇总 ===",flush=True)
summary={}
for sl,tr in configs:
    tot=0;cnt=0
    for sym in POOL:
        try: r=run(fetch(sym),sl,tr)
        except: continue
        if r: tot+=r['net'];cnt+=1
    key=f"{tr*100:.0f}%r/{sl*100:.0f}%s"
    summary[key]=(tot/max(cnt,1),cnt)
    print(f"  {key}: 平均净{tot/max(cnt,1):+.2f}% ({cnt}币)",flush=True)
best=max(summary.items(),key=lambda x:x[1][0])
print(f"\n🏆 最优: {best[0]} 平均净{best[1][0]:+.2f}%",flush=True)
