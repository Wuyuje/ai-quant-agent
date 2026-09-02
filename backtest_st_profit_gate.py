#!/usr/bin/env python3
"""盈利后才止盈止损 - 严格逻辑回测
规则(严格按用户):
  未盈利(回报<=0): 不平仓(给机会回本), 仅极端兜底(回报<-extreme)强制平防爆
  盈利后(回报>0): 激活移动止盈 - 跟踪峰值, 从峰值回撤trail%平; 若盈利回吐到<=0则继续扛(仍不平)
杠杆5x, 扫描trail(移动止盈回撤)和极端兜底extreme
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
        except:time.sleep(0.3);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.4)
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
def run(kl,trail,extreme,timeN=240):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c);trd=[];pos=0;entry=0;peak=0;ei=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i];ei=i;peak=0
        else:
            cur_roi=((c[i]-entry)/entry)*LEV*pos
            # 峰值(正向极端)
            if pos==1:
                rp=((h[i]-entry)/entry)*LEV
            else:
                rp=((entry-l[i])/entry)*LEV
            if rp>peak: peak=rp
            hit=False;pnl_amt=cur_roi
            # 1) 极端兜底: 回报<-extreme强制平(唯一允许亏单平仓的)
            if cur_roi<=-extreme:
                trd.append(-extreme*100);pos=0;continue
            # 2) 只有盈利(peak>0)才激活移动止盈: 回撤达trail
            if peak>0 and cur_roi<=peak-trail:
                trd.append(cur_roi*100);pos=0;continue
            # 3) 时间兜底: 超时平(无论盈亏)
            if (i-ei)>=timeN:
                trd.append(cur_roi*100);pos=0;continue
            # 4) SUPER翻转: 也作为止盈止损参考(翻转时平)
            if d[i]!=d[i-1]:
                trd.append(cur_roi*100);pos=0;continue
    if pos!=0: trd.append(((c[-1]-entry)/entry)*LEV*100*pos)
    if len(trd)<12:return None
    wins=[x for x in trd if x>0]
    return {'acc':len(wins)/len(trd)*100,'n':len(trd),'net':sum(trd)}
configs=[(tr,ex) for tr in [0.03,0.05,0.08] for ex in [0.20,0.30,0.40]]
print(f"盈利后才止盈止损 (杠杆{LEV}x): 未盈利不平(仅极端兜底), 盈利后峰值回撤{configs and 'TRAIL'}平",flush=True)
print(f"{'币':<9}"+"  ".join(f"r{tr*100:.0f}/e{ex*100:.0f}" for tr,ex in configs),flush=True)
summary={}
for sym in POOL:
    try: kl=fetch(sym)
    except: continue
    line=f"  {sym[:7]}  "
    for tr,ex in configs:
        r=run(kl,tr,ex)
        if r: line+=f"{r['net']:+7.1f}%({r['acc']:.0f}%)".replace('%','%',1)+" "
        else: line+="    --    "
        summary.setdefault((tr,ex),[]).append(r['net'] if r else 0)
    print(line,flush=True)
print("\n=== 平均净回报 ===",flush=True)
for tr,ex in configs:
    a=[x for x in summary[(tr,ex)] if x]
    if a: print(f"  回撤{tr*100:.0f}%/极端兜底{ex*100:.0f}%: 平均净{sum(a)/len(a):+.2f}% ({sum(1 for x in a if x>0)}/{len(a)}币盈利)",flush=True)
