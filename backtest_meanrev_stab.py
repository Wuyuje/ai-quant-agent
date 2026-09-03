#!/usr/bin/env python3
"""均值回归 独立时段稳定性验证
把历史K线分前后两半独立回测, 看是否两段都正(稳定)而非单段侥幸
参数: 15m BB20±2.0 RSI30-70 SL2.5ATR (之前9/9币正)
对比: 前段净 vs 后段净 vs 全程, 验证稳定性
"""
import urllib.request,json,time,math
UA={'User-Agent':'Mozilla/5.0'}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','LINKUSDT','ADAUSDT']
LEV=3.0; FEE=0.0004; COMPUTE=0.30
def fetch(sym,ivl,limit):
    ak=[];end=None;eta=1620000000000
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={ivl}&limit=1000&startTime={eta}&endTime={int(time.time()*1000)}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        except:time.sleep(0.4);break
        if not b:break
        ak+=b;last=b[-1][0];eta=last+1;time.sleep(0.3)
        # limit达到或已到最近
        if len(ak)>=limit:break
    # 取最后limit根(最近数据,含当前)
    ak=ak[-limit:]
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def run(kl):
    h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl];n=len(c)
    rsi=[50.0]*n
    for i in range(15,n):
        g=lo=0.0
        for j in range(i-14,i):
            dd=c[j]-c[j-1]
            g+=dd if dd>0 else 0; lo-=dd if dd<0 else 0
        rsi[i]=100-100/(1+((g/14)/(lo/14) if lo>1e-12 else 999))
    pos=0;entry=0;gross=[]
    SL_PCT=2.5   # 反向-2.5%价格止损(回归失败)
    for i in range(20,n):
        if pos==0:
            seg=c[i-19:i+1];m=sum(seg)/20
            sd=math.sqrt(sum((x-m)**2 for x in seg)/20) or 1e-9
            up=m+2*sd;dn=m-2*sd
            if c[i]<=dn and rsi[i]<30: pos=1;entry=c[i]
            elif c[i]>=up and rsi[i]>70: pos=-1;entry=c[i]
        else:
            seg=c[i-19:i+1];m=sum(seg)/20
            chg=(c[i]-entry)/entry*100  # 价格%
            # 止盈: 回归到布林中轨(均值)
            if (pos==1 and c[i]>=m) or (pos==-1 and c[i]<=m):
                gross.append(chg*LEV);pos=0;continue
            # 止损: 反方向走SL_PCT%
            if (pos==1 and chg<=-SL_PCT) or (pos==-1 and chg<=-SL_PCT):
                gross.append(chg*LEV);pos=0;continue
    return gross

def moneyarr(gross):
    if len(gross)<8:return None
    real=[]
    for roi in gross:  # 已含杠杆价格*LEV
        fee_pct=LEV*FEE*2*100
        net=roi-fee_pct
        if net>0:net*=(1-COMPUTE)
        real.append(net)
    w=[x for x in real if x>0]
    return len(w)/len(real)*100,len(real),sum(real)
print("均值回归(15m BB20/RSI30-70) 独立时段稳定性",flush=True)
print(f"{'币':<9}{'前段净':>9}{'后段净':>9}{'全程净':>9}{'前币数':>7}{'后币数':>7}{'判定':>6}",flush=True)
res=[]
for sym in POOL:
    try: kl=fetch(sym,'15m',1400)  # ~1400根 15m近似分段
    except: continue
    if len(kl)<500: print(f" {sym} 数据少");continue
    half=len(kl)//2
    for label,seg,cond in [('前',kl[:half],0),('后',kl[half:],1)]:
        pass
    g1=run(kl[:half]); g2=run(kl[half:]); gout=run(kl)
    m1=moneyarr(g1); m2=moneyarr(g2); m3=moneyarr(gout)
    f1=f'{m1[2]:+.1f}' if m1 else '--'; f2=f'{m2[2]:+.1f}' if m2 else '--'; f3=f'{m3[2]:+.1f}' if m3 else '--'
    c1=str(m1[1]) if m1 else '0'; c2=str(m2[1]) if m2 else '0'
    stab='✅稳' if (m1 and m2 and m1[2]>0 and m2[2]>0) else ('⚠️' if (m1 and m2) else '-')
    print(f"  {sym:<8}{f1:>8}{f2:>8}{f3:>8}{c1:>6}{c2:>6}  {stab}",flush=True)
    if m1 and m2:res.append((m1[2],m2[2]))
if res:
    both=sum(1 for a,b in res if a>0 and b>0)
    print(f"\n前段&后段都正 : {both}/{len(res)}币",flush=True)
    print(f"前段均净:{sum(a for a,b in res)/len(res):+.1f}%  后段均净:{sum(b for a,b in res)/len(res):+.1f}%",flush=True)
