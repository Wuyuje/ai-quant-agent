#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MACD金叉买入 + KDJ死叉卖出 策略回测 (5分钟)
规则: 5m K线
  买入: MACD金叉 (DIF上穿DEA)
  卖出: KDJ死叉 (J线下穿K线且下穿D线)
数据: 币安 5m 真实
手续费: 0.05% taker, 开+平=0.10%
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','INJUSDT','PEPEUSDT','WIFUSDT']
FEE=0.0005   # 单边0.05%

def get_klines(sym,interval='5m',pages=6):
    data=[]; et=''
    for _ in range(pages):
        url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
        if et: url+=f'&endTime={et}'
        try: b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
        except: break
        if not b: break
        data=b+data; et=str(b[0][0]-1); time.sleep(0.13)
    data.sort(key=lambda x:x[0])
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4])} for x in data]

def ema_series(v,n):
    out=[None]*len(v)
    if len(v)<n: return out
    k=2/(n+1); e=v[0]; out[0]=e
    for i in range(1,len(v)): e=v[i]*k+e*(1-k); out[i]=e
    return out

def macd(c):
    """返回 (dif,dea) 序列, MACD(12,26,9)"""
    e12=ema_series(c,12); e26=ema_series(c,26)
    dif=[None]*len(c)
    for i in range(len(c)):
        if e12[i] is not None and e26[i] is not None: dif[i]=e12[i]-e26[i]
    # DEA = DIF的9EMA
    dea=[None]*len(c); 
    # 找到DIF非None起点
    start=next((i for i,v in enumerate(dif) if v is not None), None)
    if start is not None:
        k=2/10; e=dif[start]; dea[start]=e
        for i in range(start+1,len(c)):
            if dif[i] is None: dea[i]=None; continue
            e=dif[i]*k+e*(1-k); dea[i]=e
    return dif,dea

def kdj(kl):
    """KDJ(9,3,3): 返回 (j,k,d) 序列"""
    n=9; kper=1/3; dper=1/3
    kk=[None]*len(kl); dd=[None]*len(kl); jj=[None]*len(kl)
    k_prev=50.0; d_prev=50.0
    for i in range(len(kl)):
        if i<n-1: continue
        ll=min(kl[t]['l'] for t in range(i-n+1,i+1))
        hh=max(kl[t]['h'] for t in range(i-n+1,i+1))
        c=kl[i]['c']
        rsv=(c-ll)/(hh-ll)*100 if hh!=ll else 50.0
        k_now=kper*rsv+(1-kper)*k_prev
        d_now=dper*k_now+(1-dper)*d_prev
        kk[i]=k_now; dd[i]=d_now; jj[i]=3*k_now-2*d_now
        k_prev=k_now; d_prev=d_now
    return jj,kk,dd

def backtest(sym):
    kl=get_klines(sym)
    if not kl or len(kl)<500: return None
    c=[k['c'] for k in kl]
    dif,dea=macd(c)
    jj,kk,dd=kdj(kl)
    bal=1000.0; pos=None; entry=None
    t=0; wins=0; realized=0.0; worst=0
    in_pos=False
    for i in range(35,len(kl)):
        # 买入: MACD金叉 DIF上穿DEA, 且无持仓
        if not in_pos:
            if (dif[i] is not None and dif[i-1] is not None and dea[i] is not None and dea[i-1] is not None
                and dif[i-1]<=dea[i-1] and dif[i]>dea[i]):
                # 金叉买入
                entry=c[i]; in_pos=True
        else:
            # 卖出: KDJ死叉 J下穿K 且 J下穿D, 且J从上方来
            if (jj[i] is not None and jj[i-1] is not None and kk[i] is not None and dd[i] is not None):
                cross_k = jj[i-1]>=kk[i-1] and jj[i]<kk[i]     # J下穿K
                cross_d = jj[i-1]>=dd[i-1] and jj[i]<dd[i]     # J下穿D
                if cross_k and cross_d:
                    exit_p=c[i]
                    pnl_pct=(exit_p-entry)/entry
                    pnl=pnl_pct*bal*0.9   # 用90%仓位简化
                    fee=2*FEE*bal*0.9
                    net=pnl-fee
                    bal+=net; realized+=net
                    t+=1; worst=min(worst,net)
                    if net>0: wins+=1
                    in_pos=False
    # 收尾: 仍持仓则按最后价平(不计入t)
    return {'t':t,'w':wins,'realized':realized,'worst':worst}

print("═══ MACD金叉买入 + KDJ死叉卖出 回测(5m, 15币) ═══\n")
print("说明: 5m级别, 手续费0.10%双边\n")
agg=[0,0,0.0,0]
for sym in SYMBOLS:
    try:
        r=backtest(sym)
        if not r or r['t']==0: 
            print(f"{sym:10} 无交易")
            continue
        agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['realized'];agg[3]=min(agg[3],r['worst'])
        print(f"{sym:10} {r['t']}笔 胜率{r['w']*100//r['t']}% 净{r['realized']:+.1f}USDT 日均约{r['realized']/40:+.2f}")
    except Exception as e: print(f"{sym:10} err {str(e)[:15]}")
t,w,real,worst=agg
print(f"\n════ 汇总: {t}笔 胜率{w*100//t if t else 0}% 净{real:+.1f}USDT(起点1000) 最差单{worst:+.1f} ════")
print('净>0 →', '✅ 盈利' if real>0 else '❌ 亏损')
