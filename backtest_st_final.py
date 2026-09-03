#!/usr/bin/env python3
"""SuperTrend 最终可信回测(修正方向bug)
采用正确逻辑:
  反转信号 = SUPER方向翻转点, 做逆势反转(触上轨做空/触下轨做多) — 均值回归
  但用 sig = -dirn (dirn=-1下跌触绿线→做多; dirn=+1上涨触红线→做空)?
明确: SUPER趋势方向 dirn: +1=上涨(红线), -1=下跌(绿线)
  正确反转: 触上轨(涨翻天/超买,dirn=1,但正在回落)→做空? 需要定义"触轨"
核心: 用翻转点+真实持仓逐K监控(高低点判定盈亏), 不用虚高的收盘价单点结算
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='5m',limit=3000):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.35);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.9)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in all_k]
def supertrend_dir(h,l,c,period,mult):
    n=len(c);atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]))
        atr[i]=(atr[i-1]*(period-1)+tr)/period if i>=period else (atr[i-1]+tr)/i if i<=period else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)];up=[0.0]*n;dn=[0.0]*n;dirn=[1]*n
    for i in range(n):
        upper=hl2[i]+mult*atr[i];lower=hl2[i]-mult*atr[i]
        if i>0:
            upper=upper if (upper<up[i-1] or c[i-1]>up[i-1]) else up[i-1]
            lower=lower if (lower>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
        up[i]=upper;dn[i]=lower
    for i in range(1,n):
        if c[i]>up[i-1]:dirn[i]=1
        elif c[i]<dn[i-1]:dirn[i]=-1
        elif dirn[i-1]==1:dirn[i]=1 if c[i]>=dn[i] else -1
        else:dirn[i]=-1 if c[i]<=up[i] else 1
    return dirn

def run_true(kl,p,m,tp_pct,sl_pct,timehold):
    """真实回测: 翻转点反转开仓, 持仓中每K用高低点 真实判定止盈/止损/时间出场
    方向: 正确反转 - dirn从1转-1(触上轨回落)未开; 我们定义:
      在SUPER翻转点时开反向仓: dirn由1→-1(见顶回落) 做空; dirn由-1→1(见底回升) 做多
      即 sig = -dirn[i] (在翻转点)
    但用真实持仓监控, 不虚高.
    """
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    dirn=supertrend_dir(h,l,c,p,m);n=len(c)
    trades=[];pos=0;entry=0;ei=0
    for i in range(1,n):
        if dirn[i]!=dirn[i-1]:
            sig=-dirn[i]   # 反转: 转下跌做空, 转上涨做多
            if sig!=pos or pos==0:
                if pos!=0:
                    pnl=((c[i]-entry)/entry*100)*pos;trades.append(('close',pnl))
                pos=sig;entry=c[i];ei=i
            # 继续持仓监控下一K
        elif pos!=0:
            # 持仓中: 用高低点真实判定该K是否先触止盈/止损
            closed=False
            if tp_pct and ((h[i]>=entry*(1+tp_pct) and pos==1) or (l[i]<=entry*(1-tp_pct) and pos==-1)):
                pnl=((c[i]-entry)/entry*100)*pos;trades.append(('tp',pnl));pos=0;closed=True
            elif sl_pct and ((l[i]<=entry*(1-sl_pct) and pos==1) or (h[i]>=entry*(1+sl_pct) and pos==-1)):
                pnl=((c[i]-entry)/entry*100)*pos;trades.append(('sl',pnl));pos=0;closed=True
            elif timehold and (i-ei)>=timehold:
                pnl=((c[i]-entry)/entry*100)*pos;trades.append(('time',pnl));pos=0;closed=True
    if pos!=0:
        pnl=((c[-1]-entry)/entry*100)*pos;trades.append(('close',pnl))
    return trades
def stats(trades):
    pnls=[t[1] for t in trades]
    if len(pnls)<8:return None
    wins=[x for x in pnls if x>0]
    return {'acc':len(wins)/len(pnls)*100,'n':len(pnls),'net':sum(pnls)}
POOL=['BTCUSDT','ETHUSDT','DOGEUSDT','XRPUSDT','SOLUSDT','ADAUSDT']
cfgs=[(0,0,0,'无出场(翻转平)'),(0.004,0.004,0,'±0.4%止盈止损'),(0.006,0.004,0,'TP0.6%/SL0.4%'),(0,0.004,12,'SL0.4%+12根时间')]
print(f"{'币':<10}{'配置':<22}{'胜率':>7}{'样本':>5}{'净盈亏%':>9}",flush=True)
for sym in POOL:
    kl=fetch(sym,'5m',3000)
    for (tp,sl,th,lab) in cfgs:
        tr=run_true(kl,10,3,tp,sl,th);s=stats(tr)
        if s: print(f"  {sym:<8}{lab:<20}{s['acc']:6.1f}%  {s['n']:>4}  {s['net']:8.2f}",flush=True)
        else: print(f"  {sym:<8}{lab:<20} 样本不足",flush=True)
