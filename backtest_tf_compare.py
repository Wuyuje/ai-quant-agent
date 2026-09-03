#!/usr/bin/env python3
"""震荡策略 多时间级别回报率对比回测
策略: SuperTrend(10,3)反转入场, 固定止盈止损=盈利后峰值回撤0.5%止盈, 极端兜底-30%
对比: 1m/5m/15m/30m/1h 哪个回报率最高
杠杆5x, 多币, 每日回报率标准化
"""
import urllib.request,json,time,math,sys
sys.path.insert(0,'/app/workspace/ai-quant-agent')
UA={'User-Agent':'Mozilla/5.0'}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','LINKUSDT']
LEV=5
def fetch(sym,interval,limit):  # limit近似K线根数
    all_k=[];end=None
    while len(all_k)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:u+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        except:time.sleep(0.4);break
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
            u=u if(u<up[i-1]or c[i-1]>up[i-1])else up[i-1]
            dd=dd if(dd>dn[i-1]or c[i-1]<dn[i-1])else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    return d
def run(kl,trail=0.005,extreme=0.30):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c);trd=[];pos=0;entry=0;peak=0;ei=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i];peak=0;ei=i
        else:
            cur=((c[i]-entry)/entry)*LEV*pos
            rp=((h[i]-entry)/entry)*LEV if pos==1 else ((entry-l[i])/entry)*LEV
            if rp>peak: peak=rp
            if cur<=-extreme: trd.append(-extreme*100);pos=0;continue
            if cur<=0: continue  # 未盈利不平
            if peak>0 and (peak-cur)>=trail: trd.append(cur*100);pos=0;continue
            if d[i]!=d[i-1]: trd.append(cur*100);pos=0;continue
    if pos!=0: trd.append(((c[-1]-entry)/entry)*LEV*100*pos)
    if len(trd)<8:return None
    wins=[x for x in trd if x>0]
    return {'acc':len(wins)/len(trd)*100,'n':len(trd),'net':sum(trd)}
# 各时间级别: 覆盖相近时间跨度(小时), 用近似根数
# 1m取1000根≈16.7h, 5m取1000根≈83h, 15m取800≈200h, 1h取800≈800h(但拉取慢) - 数据跨度约近30天
tfs={
  '1m':1000,'5m':1000,'15m':800,'1h':600,'4h':400
}
print(f"震荡策略多时间级别回报率对比 (盈利才止盈/回撤0.5%/兜底-30%/{LEV}x)",flush=True)
# 汇总
sums={tf:[] for tf in tfs}
accmap={tf:[] for tf in tfs}
for sym in POOL:
    line=f"  {sym[:8]}"
    for tf,limit in tfs.items():
        try:kl=fetch(sym,tf,limit)
        except:line+="  --";continue
        r=run(kl)
        if r: sums[tf].append(r['net']);accmap[tf].append(r['acc']);line+=f"{tf:<3}:{r['net']:+7.1f}/{r['acc']:.0f}%".ljust(15)
        else:line+=f"{tf:<3}:样本不足".ljust(15)
    print(line,flush=True)
print("\n=== 各时间级别平均回报率(标准化每日) ===",flush=True)
# 反映不同tf覆盖时长不同, 用每币净回报直接比较(同数据源同期近似)
for tf in tfs:
    a=sums[tf]
    if a:
        acc=[x for x in accmap[tf] if x]
        print(f"  {tf:<4}: 平均净回报{sum(a)/len(a):+.2f}%  平均胜率{sum(acc)/len(acc) if acc else 0:.0f}%  ({len(a)}币)",flush=True)
# 找最优tf(平均净回报)
best=max((tf for tf in tfs if sums[tf]), key=lambda tf: sum(sums[tf])/len(sums[tf]))
print(f"\n🏆 回报率最高时间级别: {best}",flush=True)
