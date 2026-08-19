#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MACD+KDJ 双向策略回测 (5分钟, 只做 BTC+ETH)
做多: MACD金叉(DIF上穿DEA)买入 → KDJ死叉(J下穿K且D)卖出平多
做空: MACD死叉(DIF下穿DEA)买入做空 → KDJ金叉(J上穿K且D)卖出平空
数据: 币安 5m 真实 (拉6页×1000≈更久)
手续费: 0.05%单边, 开+平=0.10%
资金: 1000, 满仓单一方向
"""
import urllib.request, json, time

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT']   # 只做1-2只
FEE=0.0005

def get_klines(sym,interval='1h',pages=9):
    data=[]; et=''
    for _ in range(pages):
        url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
        if et: url+=f'&endTime={et}'
        try: b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
        except: break
        if not b: break
        data=b+data; et=str(b[0][0]-1); time.sleep(0.15)
    data.sort(key=lambda x:x[0])
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4])} for x in data]

def ema_series(v,n):
    out=[None]*len(v)
    if len(v)<n: return out
    k=2/(n+1); e=v[0]; out[0]=e
    for i in range(1,len(v)): e=v[i]*k+e*(1-k); out[i]=e
    return out

def macd(c):
    n=len(c); e12=ema_series(c,12); e26=ema_series(c,26)
    dif=[None]*n
    for i in range(n):
        if e12[i] is not None and e26[i] is not None: dif[i]=e12[i]-e26[i]
    start=next((i for i,v in enumerate(dif) if v is not None), None)
    dea=[None]*n
    if start is not None:
        k=2/10; e=dif[start]; dea[start]=e
        for i in range(start+1,n):
            if dif[i] is None: dea[i]=None; continue
            e=dif[i]*k+e*(1-k); dea[i]=e
    return dif,dea

def kdj(kl):
    n=9; kper=1/3; dper=1/3
    L=len(kl); kk=[None]*L; dd=[None]*L; jj=[None]*L
    k_prev=50.0; d_prev=50.0
    for i in range(L):
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
    print(f"  {sym}: 拉取 {len(kl)} 根 1h K线")
    c=[k['c'] for k in kl]
    dif,dea=macd(c); jj,kk,dd=kdj(kl)
    e50=ema_series(c,50)   # EMA50趋势过滤
    bal=1000.0; pos=None  # 'LONG'/'SHORT'/None
    entry=0.0
    t=0; wins=0; realized=0.0; worst=0
    for i in range(35,len(kl)):
        # 开仓信号
        if pos is None:
            if (dif[i] is not None and dif[i-1] is not None and dea[i] is not None and dea[i-1] is not None):
                gold = dif[i-1]<=dea[i-1] and dif[i]>dea[i]       # 金叉
                dead = dif[i-1]>=dea[i-1] and dif[i]<dea[i]       # 死叉
                price_now=c[i]
                if gold and e50[i] is not None and price_now>e50[i]:
                    pos='LONG'; entry=c[i]          # 金叉+价>EMA50(上行)才做多
                elif dead and e50[i] is not None and price_now<e50[i]:
                    pos='SHORT'; entry=c[i]         # 死叉+价<EMA50(下行)才做空
        else:
            # 平仓
            if (jj[i] is not None and jj[i-1] is not None and kk[i] is not None and dd[i] is not None):
                close_sell = jj[i-1]>=kk[i-1] and jj[i]<kk[i] and jj[i-1]>=dd[i-1] and jj[i]<dd[i]  # J下穿K&D = 平多
                close_buy  = jj[i-1]<=kk[i-1] and jj[i]>kk[i] and jj[i-1]<=dd[i-1] and jj[i]>dd[i]  # J上穿K&D = 平空
                if pos=='LONG' and close_sell:
                    exit_p=c[i]; pnl_pct=(exit_p-entry)/entry
                elif pos=='SHORT' and close_buy:
                    exit_p=c[i]; pnl_pct=(entry-exit_p)/entry
                else:
                    continue
                pnl=pnl_pct*bal; fee=2*FEE*bal; net=pnl-fee
                bal+=net; realized+=net; t+=1; worst=min(worst,net)
                if net>0: wins+=1
                pos=None
    return {'t':t,'w':wins,'realized':realized,'worst':worst,'bal':bal}

print("═══ MACD+KDJ 双向策略1h+EMA50过滤 (只做 BTC/ETH) ═══\n")
agg=[0,0,0.0,0,1000.0]
for sym in SYMBOLS:
    try:
        r=backtest(sym)
        if not r or r['t']==0:
            print(f"{sym} 无交易"); continue
        print(f"  {sym}: {r['t']}笔 胜率{r['w']*100//r['t']}% 净{r['realized']:+.1f}USDT 期末{r['bal']:.0f}")
        agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['realized'];agg[3]=min(agg[3],r['worst'])
    except Exception as e: print(f"{sym} err {str(e)[:20]}")
t,w,real,worst,end_bal=agg
print(f"\n════ 汇总: {t}笔 胜率{w*100//t if t else 0}% 净{real:+.1f}USDT 最差单{worst:+.1f} ════")
print('净>0(扣手续费) →', '✅ 盈利' if real>0 else '❌ 亏损')