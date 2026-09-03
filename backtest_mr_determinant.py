#!/usr/bin/env python3
"""均值回归 判别分析: 找出'能赚vs不能赚'震荡的可量化差异(作过滤器)
用独立时段数据观察: 赚钱阶段 vs 亏钱阶段的 波动率/带宽特征差异
若无差异→震荡无稳定盈利特征→不能靠'该赚才开'
有差异→提炼过滤条件
"""
import urllib.request,json,time,math
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,ivl='15m',limit=1800):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={ivl}&limit=1000'+(('&endTime='+end) if end else '')
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        except:time.sleep(0.4);break
        if not b:break
        ak=b+ak;end=str(int(b[0][0])-1);time.sleep(0.4)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def run_return_per_trade(kl,n=20,k=2.0,rsiL=30,rsiH=70):
    h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    N=len(c);rsi=[50.0]*N
    for i in range(15,N):
        g=lo=0.0
        for j in range(i-14,i):
            dd=c[j]-c[j-1]
            if dd>0:g+=dd
            elif dd<0:lo-=dd
        rsi[i]=100-100/(1+((g/14)/(lo/14) if lo>1e-12 else 999))
    # 记录每笔(开仓时ATR%和带宽宽度%, 该笔结果)
    pos=0;entry=0;rows=[]
    for i in range(n,N):
        seg=c[i-n+1:i+1];m=sum(seg)/n;sd=math.sqrt(sum((x-m)**2 for x in seg)/n) or 1e-9
        up=m+k*sd;dn=m-k*sd;r=rsi[i]
        if pos==0:
            if c[i]<=dn and r<rsiL: pos=1;entry=c[i];bandwidth=(up-dn)/m*100;vol=sd/m*100
            elif c[i]>=up and r>rsiH: pos=-1;entry=c[i];bandwidth=(up-dn)/m*100;vol=sd/m*100
        else:
            chg=(c[i]-entry)/entry*100*pos
            if (pos==1 and c[i]>=m) or (pos==-1 and c[i]<=m):
                rows.append((bandwidth,vol, chg));pos=0
            elif chg<=-2.5:
                rows.append((bandwidth,vol, chg));pos=0
    return rows
for sym in ['XRPUSDT','ETHUSDT','BTCUSDT','DOGEUSDT']:
    try: kl=fetch(sym)  # 用最近独立段(应属偏难时段)
    except:continue
    rows=run_return_per_trade(kl)
    if len(rows)<5: continue
    # 总净
    tot=sum(x[2] for x in rows)
    win=[x for x in rows if x[2]>0]; lose=[x for x in rows if x[2]<=0]
    bw_w=sum(x[0] for x in win)/len(win) if win else 0
    bw_l=sum(x[0] for x in lose)/len(lose) if lose else 0
    vol_w=sum(x[1] for x in win)/len(win) if win else 0
    vol_l=sum(x[1] for x in lose)/len(lose) if lose else 0
    print(f"== {sym} (近18天15m) 总净{tot:+.1f}% 共{len(rows)}笔 胜{len(win)}/亏{len(lose)} ==",flush=True)
    print(f"   盈利笔:带宽中{win and sorted(x[0] for x in win)[len(win)//2]:.2f}%  亏损笔带宽中{lose and sorted(x[0] for x in lose)[len(lose)//2]:.2f}%",flush=True)
    print(f"   盈利笔波动{lose and vol_w:.2f}% 亏笔波动{vol_l:.2f}% | 盈利笔均{bw_w:.1f}带宽 亏笔均{bw_l:.1f}",flush=True)
    # 用带宽分档 看窄带vs宽带盈亏
    for wl,lo_,hi_,lab in [('窄带',0,8,'<8%'),('中带',8,15,'8-15%'),('宽带',15,999,'>15%')]:
        rr=[x for x in rows if lo_<=x[0]<hi_]
        if rr:
            nn=sum(x[2] for x in rr)
            print(f"   {lab}(带宽{lo_}-{hi_}%): {len(rr)}笔 净{nn:+.1f}%",flush=True)
print("\n→ 若不同带宽/波动档位净回报有明显正负分区 = 可做过滤器；若几乎都负或都正则无法判别",flush=True)
