#!/usr/bin/env python3
"""SUPER反转 严谨真实回测 - 不含扛单虚高
关键修正: 不用"扛到翻转才平"的虚高机制
真实方式A: 固定持仓H根K线后按收盘结算(模拟真持有时长)
真实方式B: 持仓中遇到反向SUPER翻转立即平仓(按该K开盘或收盘)
分别统计真实胜率/盈亏, 对比"扛到翻转"版
"""
import urllib.request,json,time,math
import numpy as np
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='5m',limit=2500):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.35);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.8)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in all_k]
def st_dir(o,h,l,c,p,m):
    n=len(c);atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]))
        atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
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
def run_fix_hold(kl,p,m,H):
    """固定持仓H根结算(真实)"""
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=st_dir(o,h,l,c,p,m);n=len(c)
    trades=[];pos=0;entry=0;ei=0
    for i in range(1,n-1):
        if pos==0:
            if d[i]!=d[i-1]:
                pos=-d[i];entry=c[i];ei=i   # 开仓用当前收盘
        else:
            # 固定持仓H根后结算
            if i-ei>=H:
                pnl=((c[i]-entry)/entry*100)*pos;trades.append(pnl);pos=0
    if pos!=0: trades.append((((c[-1]-entry)/entry*100)*pos))
    return trades
def run_turn_tp(kl,p,m):
    """持仓遇到反向SUPER翻转平仓(但用翻转点收盘价) - 原机制"""
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=st_dir(o,h,l,c,p,m);n=len(c)
    trades=[];pos=0;entry=0
    for i in range(1,n):
        if d[i]!=d[i-1]:
            sig=-d[i]
            if pos!=0 and sig!=pos:
                pnl=((c[i]-entry)/entry*100)*pos;trades.append(pnl);pos=0
            if pos==0:pos=sig;entry=c[i]
    if pos!=0:trades.append((((c[-1]-entry)/entry*100)*pos))
    return trades
def stats(trades):
    if len(trades)<10:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
POOL=['BTCUSDT','ETHUSDT','DOGEUSDT','XRPUSDT','SOLUSDT','ADAUSDT']
print(f"{'币':<9}{'方式':<22}{'胜率':>7}{'样本':>5}{'净盈亏%':>9}",flush=True)
for sym in POOL:
    kl=fetch(sym,'5m',2500)
    # 原机制(扛到翻转)
    t_turn=run_turn_tp(kl,10,3);s_turn=stats(t_turn)
    # 固定持仓 3/5/8 根
    for H,lab in [(3,'固定持仓3根(15分)'),(5,'固定持仓5根(25分)'),(8,'固定持仓8根(40分)')]:
        t=run_fix_hold(kl,10,3,H);s=stats(t)
        if s:print(f"  {sym:<7}{lab:<20}{s['acc']:6.1f}%  {s['n']:>4}  {s['net']:8.2f}",flush=True)
        else:print(f"  {sym:<7}{lab:<20} 样本不足",flush=True)
    if s_turn:print(f"  {sym:<7}{'扛到翻转(原机制)':<18}{s_turn['acc']:6.1f}%  {s_turn['n']:>4}  {s_turn['net']:8.2f}",flush=True)
