#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""布林策略: 原来开仓逻辑 + 反向开仓 回测对比
反向: 原逻辑(canOpen收口准入 + 触轨信号方向)取反
  原 触上轨→SHORT, 触下轨→LONG
  反:触上轨→LONG,  触下轨→SHORT
对比: 正向 vs 反向, 周期 5m/1h/4h
手续费 0.1%(合约taker 0.05%x2) 按名义
管理: 复刻bollinger checkTakeProfit(轨道/ATR移动)+checkHardStop(前置风控20%)
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT','INJUSDT','SEIUSDT','FETUSDT']
FEE=0.0005   # 单边0.05%, 开+平=0.1%

def get_klines(sym,interval,pages=3):
    data=[];et=''
    for _ in range(pages):
        url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
        if et: url+=f'&endTime={et}'
        try: b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
        except: break
        if not b: break
        data=b+data;et=str(b[0][0]);time.sleep(0.13)
    data.sort(key=lambda x:x[0])
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'v':float(x[5])} for x in data]

def bands(c,i,n=20,k=2.0):
    s=c[i-n:i]
    if len(s)<n: return None
    m=sum(s)/n; sd=math.sqrt(sum((x-m)**2 for x in s)/n)
    return {'mid':m,'up':m+k*sd,'lo':m-k*sd,'sd':sd,'width':(2*k*sd)/(m or 1)}

def atr(kl,i,n=14):
    trs=[]
    for j in range(max(1,i-n+1),i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c'];trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs) if len(trs)>=n else None

def width_pct(c,i,b,histn=100,n=20):
    if i<histn+n: return 0.5
    wins=[]
    for j in range(i-histn,i):
        bb=bands(c,j+1,n)
        if bb: wins.append(bb['width'])
    return sum(1 for w in wins if w<b['width'])/len(wins) if wins else 0.5

def is_shrinking(c,i,n=20,shrinkbars=3):
    rw=[]
    for j in range(max(n,i-shrinkbars+1),i+1):
        bb=bands(c,j,n)
        if bb: rw.append(bb['width'])
    if len(rw)<shrinkbars: return False
    return all(rw[x]<rw[x-1] for x in range(1,len(rw)))

def can_open(c,i):
    b=bands(c,i)
    if not b: return False,None
    wpc=width_pct(c,i,b)
    if wpc>0.90: return False,None
    if wpc<=0.85 and is_shrinking(c,i): return True,b
    return False,None

def manage_boll(kl,c,i,side,entry,interval,loss_kill=20):
    """复刻checkTakeProfit(触中轨/ATR移动)+checkHardStop(前置风控).
    interval: '5m'->trail 0.3ATR; '1h'/'4h' 用更长窗口
    """
    a=atr(kl,i)
    if not a: return None
    b=bands(c,i)
    if not b: return None
    best=entry; low_since=entry; high_since=entry
    for j in range(i+1,min(i+2000,len(kl))):
        cj=kl[j]['c']; hi=kl[j]['h']; lo=kl[j]['l']
        pnl_pct = (cj-entry)/entry if side=='LONG' else (entry-cj)/entry
        # 前置风控: 单K(盘中)浮亏>=loss_kill%本金(用10x杠杆近似本金, 这里简化用价格%)
        if side=='LONG':
            worst=(entry-lo)/entry
        else:
            worst=(hi-entry)/entry
        if worst*100 >= loss_kill:  # 简化: 价格%代表本金%(杠杆1x)
            return (entry-lo)/entry if side=='LONG' else (entry-hi)/entry*-1, j   # 亏损
        # 轨道止盈: 触中轨且浮盈>0
        if side=='LONG' and cj>=b['mid'] and pnl_pct>0: return pnl_pct, j
        if side=='SHORT' and cj<=b['mid'] and pnl_pct>0: return pnl_pct, j
    return None

def backtest(sym,interval,reverse=False):
    kl=get_klines(sym,interval,3)
    if len(kl)<400: return None
    c=[k['c'] for k in kl]
    t=w=0;ret=0.0; i=150
    while i<len(c)-20:
        b=bands(c,i)
        if not b: i+=1;continue
        ok,bo=can_open(c,i)
        if not ok: i+=1;continue
        price=c[i]
        sig=None
        if price>=bo['up']: sig='SHORT'
        elif price<=bo['lo']: sig='LONG'
        if not sig: i+=1;continue
        # 反向: 反转方向
        side = ('LONG' if sig=='SHORT' else 'SHORT') if reverse else sig
        r=manage_boll(kl,c,i,side,price,interval)
        if r:
            pnl,exi=r; pnl-=2*FEE; ret+=pnl; t+=1
            if pnl>0: w+=1
            i=exi+1
        else: i+=1
    return {'t':t,'w':w,'ret':ret}

print("═══ 布林: 原来开仓逻辑 正向 vs 反向 回测(0.1%手续费) ═══\n")
for interval in ['5m','1h','4h']:
    print(f"\n──────── 周期 {interval} ────────")
    aF=[0,0,0.0]; aR=[0,0,0.0]
    print(f"{'币':8} | {'正向[t/胜/总]':26} | {'反向[t/胜/总]'}")
    for sym in SYMBOLS:
        try:
            rf=backtest(sym,interval,False); rr=backtest(sym,interval,True)
            if (not rf or rf['t']==0) and (not rr or rr['t']==0): continue
            def f(r): return f"{r['t']}/{r['w']*100//r['t'] if r['t'] else 0}%/{100*r['ret']:+.0f}%"
            for r,agg in [(rf,aF),(rr,aR)]:
                if r: agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['ret']
            mark='← 反向好' if (rr and rf and rr['ret']>rf['ret']) else ''
            print(f"{sym:8} | {f(rf) if rf else '无':30} | {f(rr) if rr else '无':30} {mark}")
        except Exception as e: print(f"{sym:8} err {str(e)[:15]}")
    def sf(a): return f"{a[0]}笔 胜{a[1]*100//a[0] if a[0] else 0}% 总{100*a[2]:+.0f}%"
    print(f"\n  正向汇总: {sf(aF)}")
    print(f"  反向汇总: {sf(aR)}")
    print(f"  → {'反向更好' if aR[2]>aF[2] else '正向(原)更好'}")
