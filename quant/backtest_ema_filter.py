#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量化「加趋势方向过滤后」对开仓量和盈亏的影响
对比 4 档过滤:
  0 现状(无过滤)
  A 加 EMA200 同向闸门
  B 加 MA(近60根) 大级别闸门
  A+B 双闸门
输出每档: 开仓笔数, 胜率, 均单% → 判断是否开仓太少
"""
import json, urllib.request

def get_klines(s,iv,lim):
    url=f'https://api.binance.com/api/v3/klines?symbol={s}&interval={iv}&limit={lim}'
    return [{'c':float(k[4]),'v':float(k[5])} for k in json.load(urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'M/5.0'}),timeout=25))]

def ema(v,n):
    k=2/(n+1);e=v[0];o=[e]
    for x in v[1:]: e=x*k+e*(1-k);o.append(e)
    return o

COINS=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','LTCUSDT','DOTUSDT','SUIUSDT']

def run(sym,hold=8):
    kl=get_klines(sym,'15m',1000)
    if len(kl)<400: return None
    closes=[k['c'] for k in kl]; vols=[k['v'] for k in kl]
    e7=ema(closes,7);e25=ema(closes,25);e99=ema(closes,99);e200=ema(closes,200)
    ma60=[sum(closes[max(0,i-59):i+1])/min(60,i+1) for i in range(len(closes))]
    # 结果存各档的 pnl 列表
    res={'orig':[],'f200':[],'fma':[],'both':[]}
    for i in range(300,len(closes)-hold):
        up=e7[i]>e25[i]>e99[i];dn=e7[i]<e25[i]<e99[i]
        if not(up or dn):continue
        price=closes[i];pv_hi=max(closes[i-30:i]);pv_lo=min(closes[i-30:i])
        sig='LONG' if(up and price>pv_hi) else ('SHORT' if(dn and price<pv_lo) else None)
        if not sig:continue
        ex=closes[i+hold]
        pnl=(ex-price)/price if sig=='LONG' else (price-ex)/price
        res['orig'].append(pnl)
        # A EMA200 同向
        if (sig=='LONG')==(price>e200[i]): res['f200'].append(pnl)
        # B MA60 同向
        if (sig=='LONG')==(price>ma60[i]): res['fma'].append(pnl)
        # A+B
        if (sig=='LONG')==(price>e200[i]) and (sig=='LONG')==(price>ma60[i]): res['both'].append(pnl)
    return res

def st(l):
    if not l: return (0,0,0)
    wr=sum(1 for x in l if x>0)/len(l)*100
    return (len(l),round(wr,1),round(sum(l)/len(l)*100,3))

# 汇总
T={k:[] for k in ['orig','f200','fma','both']}
print("币种          现状(笔/胜%/均%) | +EMA200 | +MA60 | 双闸门(A+B)")
for s in COINS:
    try:
        r=run(s)
        if not r: continue
        d={k:st(r[k]) for k in r}
        line=f"{s:10} "
        for k in ['orig','f200','fma','both']:
            n,w,a=d[k]; line+=f"| {n}笔/{w}%/{a:+}% "
        print(line)
        for k in T: T[k]+=r[k]
    except Exception as e:
        print(f"{s:10} err {str(e)[:25]}")
print("\n═══ 汇总 ═══")
for k in ['orig','f200','fma','both']:
    n,w,a=st(T[k])
    label={'orig':'现状(无过滤)','f200':'只加EMA200','fma':'只加MA60','both':'双闸门'}[k]
    print(f"{label:14}: {n:4}笔  胜率{w:5.1f}%  均单{a:+.3f}%")
