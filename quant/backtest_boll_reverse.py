#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""布林策略: 现方向 vs 反向开仓 对比回测
现有布林: 收盘触/破下轨开LONG, 触/破上轨开SHORT  (顺向追突破)
反向:     收盘触/破下轨开SHORT(做反转), 触/破上轨开LONG
两种都测: 4h / 1h, 0.8ATR止损 + 3ATR止盈, 扣0.2%费
判断: 如果反向回报率更好 → 说明现有方向是反着做的(该反过来)
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT']
FEE=0.002

def get_klines(sym,interval='4h',pages=4):
    data=[];et=''
    for _ in range(pages):
        url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
        if et: url+=f'&endTime={et}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
        except: break
        if not b: break
        data=b+data;et=str(b[0][0]);time.sleep(0.15)
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'t':x[0]} for x in data]

def bolls(c,i,n=20,k=2.0):
    s=c[i-n:i]
    if len(s)<n: return None
    m=sum(s)/n; sd=math.sqrt(sum((x-m)**2 for x in s)/n)
    return {'mid':m,'up':m+k*sd,'lo':m-k*sd,'sd':sd}

def atr(kl,i,n=14):
    trs=[]
    for j in range(i-n+1,i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c'];trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs)

def simulate(kl,sig,entry,stop,tp,i,maxbars=300):
    for j in range(i+1,min(i+maxbars,len(kl))):
        hi=kl[j]['h']; lo=kl[j]['l']
        if sig=='LONG':
            if lo<=stop: return (stop-entry)/(entry or 1), j
            if hi>=tp:   return (tp-entry)/(entry or 1), j
        else:
            if hi>=stop: return (entry-stop)/(entry or 1), j
            if lo<=tp:   return (entry-tp)/(entry or 1), j
    return None,None

def backtest(sym,interval='4h'):
    kl=get_klines(sym,interval)
    if len(kl)<300: return None
    c=[k['c'] for k in kl]
    resF={'t':0,'w':0,'ret':0.0}   # 正向(现有)
    resR={'t':0,'w':0,'ret':0.0}   # 反向
    i=40
    while i<len(c)-30:
        b=bolls(c,i); a=atr(kl,i)
        if not b or not a: i+=1;continue
        price=c[i]
        # 现有正方向
        sigF = 'SHORT' if price>=b['up'] else ('LONG' if price<=b['lo'] else None)
        # 反向(反转)
        sigR = 'LONG' if price>=b['up'] else ('SHORT' if price<=b['lo'] else None)
        for res,sig,rr in [(resF,sigF,1),(resR,sigR,-1)]:
            if not sig: continue
            stop=tp_entry=0
            if sig=='LONG':
                stop=price-0.8*a; tp=price+3.0*a
            else:
                stop=price+0.8*a; tp=price-3.0*a
            pnl,exi=simulate(kl,sig,price,stop,tp,i)
            if pnl is not None:
                pnl-=2*FEE
                res['t']+=1; res['ret']+=pnl
                if pnl>0: res['w']+=1
        # 以正向信号推进(避免同一根重复)
        if sigF:
            # 重新模拟正向取得退出idx
            stop=price-0.8*a if sigF=='LONG' else price+0.8*a
            tp=price+3.0*a if sigF=='LONG' else price-3.0*a
            _,exi=simulate(kl,sigF,price,stop,tp,i)
            i=(exi+1) if exi else i+1
        else:
            i+=1
    return resF,resR

print("═══ 布林方向测试: 现有(顺向) vs 反向 回测 ═══\n")
for interval in ['4h','1h']:
    print(f"\n─── 周期 {interval} ───")
    f_t=f_w=0;f_ret=0.0; r_t=r_w=0;r_ret=0.0
    print("币种      正向(现有)[t/胜/总]      反向[t/胜/总]")
    for sym in SYMBOLS:
        try:
            r=backtest(sym,interval)
            if not r: continue
            f,rv=r
            def s(x): return f"{x['t']}/{x['w']*100//x['t'] if x['t'] else 0}%/{100*x['ret']:+.0f}%"
            f_t+=f['t'];f_w+=f['w'];f_ret+=f['ret']; r_t+=rv['t'];r_w+=rv['w'];r_ret+=rv['ret']
            print(f"{sym:10} {s(f):24} {s(rv)}")
        except Exception as e: print(sym,'err',str(e)[:18])
    print(f"── 汇总[{interval}] 正向: {f_t}笔/胜{f_w*100//f_t if f_t else 0}%/总{100*f_ret:+.1f}% | 反向: {r_t}笔/胜{r_w*100//r_t if r_t else 0}%/总{100*r_ret:+.1f}%")
    better = '反向更好' if r_ret>f_ret else '正向(现有)更好'
    print(f"→ {better}")
