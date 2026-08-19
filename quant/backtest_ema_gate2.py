#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EMA策略 三档方案对比回测
  0 修复前(无闸门)
  1 只EMA200闸门(方案2)
  2 双闸门(EMA200+4h)
数据源: 币安15m + 4h
"""
import urllib.request, json, time

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','FETUSDT','SUIUSDT','ARBUSDT']

def get_klines(sym, interval='15m', pages=2):
    data=[]; endTime=''
    try:
        for _ in range(pages):
            url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
            if endTime: url+=f'&endTime={endTime}'
            batch=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
            if not batch: break
            data=batch+data; endTime=str(batch[0][0]); time.sleep(0.15)
    except Exception: return []
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'v':float(x[5]),'t':x[0]} for x in data]

def ema(c,n):
    if len(c)<n: return None
    k=2/(n+1);e=c[-n]
    for i in range(len(c)-n+1,len(c)): e=c[i]*k+e*(1-k)
    return e

def ema_series(v,n):
    if len(v)<n: return [None]*len(v)
    out=[None]*len(v); k=2/(n+1); e=v[0]; out[0]=e
    for i in range(1,len(v)): e=v[i]*k+e*(1-k); out[i]=e
    return out

def backtest(sym):
    kl=get_klines(sym,'15m',2)
    if len(kl)<400: return None
    kl.sort(key=lambda x:x['t'])
    c=[k['c'] for k in kl]
    k4=get_klines(sym,'4h',1); k4.sort(key=lambda k:k['t'])
    c4=[k['c'] for k in k4]
    e7_4=ema(c4,7); e25_4=ema(c4,25); e99_4=ema(c4,99); p4=c4[-1]
    e7s=ema_series(c,7); e25s=ema_series(c,25); e99s=ema_series(c,99); e200s=ema_series(c,200)

    res={'orig':[0,0,0.0],'e200':[0,0,0.0],'both':[0,0,0.0]}
    def acc(key,rr):
        res[key][0]+=1
        if rr>0: res[key][1]+=1
        res[key][2]+=rr

    pos=None; g1_state=0; g2_state=0
    for i in range(200,len(c)-1):
        price=c[i]; e7=e7s[i]; e25=e25s[i]; e99=e99s[i]
        hi30=max(c[i-30:i]); lo30=min(c[i-30:i])
        if pos:
            if pos=='LONG':
                if (e7 is not None and e25 is not None and e7<e25 and price<e25) or (e99 is not None and price<e99):
                    rr=(price-pos_entry)/pos_entry
                    acc('orig',rr)
                    if g1_state: acc('e200',rr)
                    if g2_state: acc('both',rr)
                    pos=None
            else:
                if (e7 is not None and e25 is not None and e7>e25 and price>e25) or (e99 is not None and price>e99):
                    rr=(pos_entry-price)/pos_entry
                    acc('orig',rr)
                    if g1_state: acc('e200',rr)
                    if g2_state: acc('both',rr)
                    pos=None
        else:
            sig=None
            if e7 and e25 and e99:
                if e7>e25>e99 and (price>hi30 or (e25 and price>=e25*0.998)): sig='LONG'
                elif e7<e25<e99 and (price<lo30 or (e25 and price<=e25*1.002)): sig='SHORT'
            if sig:
                pos=sig; pos_entry=price
                e200=e200s[i]
                g1 = (e200 is None) or ((sig=='LONG')==(price>=e200))
                g1_state = 1 if g1 else 0
                g2=True
                if g1 and len(c4)>=60 and e7_4 is not None:
                    up4=e7_4>e25_4>e99_4; dn4=e7_4<e25_4<e99_4
                    if up4 and sig=='SHORT': g2=False
                    elif dn4 and sig=='LONG': g2=False
                    elif not up4 and not dn4:
                        if sig=='LONG' and not (p4>=e99_4): g2=False
                        elif sig=='SHORT' and not (p4<=e99_4): g2=False
                g2_state = 1 if g2 else 0
    return res

def fmt(r):
    t=r[0]; w=r[1]; ret=r[2]
    return f"{t}笔/{(w*100/t if t else 0):.1f}%/{100*ret/t if t else 0:+.3f}%/{100*ret:+.1f}%"

print("═══ EMA三档方案对比回测(币安15m 14币, 4h闸门用当前4h值) ═══\n")
agg={'orig':[0,0,0.0],'e200':[0,0,0.0],'both':[0,0,0.0]}
print("币种      修复前(无闸)       只EMA200(方案2)     双闸门(EMA200+4h)")
for sym in SYMBOLS:
    try:
        r=backtest(sym)
        if not r: continue
        for k in agg:
            agg[k][0]+=r[k][0]; agg[k][1]+=r[k][1]; agg[k][2]+=r[k][2]
        print(f"{sym:10} {fmt(r['orig']):24} {fmt(r['e200']):24} {fmt(r['both'])}")
    except Exception as e:
        print(f"{sym:10} err {str(e)[:22]}")
print("\n═══ 汇总(t笔/胜率/均单/总) ═══")
for k,l in [('orig','修复前(无闸门)'),('e200','只EMA200(方案2)'),('both','双闸门(EMA200+4h)')]:
    print(f"{l:20}: {fmt(agg[k])}")
