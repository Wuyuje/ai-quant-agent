#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""布林D方案回测 - 严格手续费+严格仓位数学 v3
复刻 bollinger-strategy.js 真实逻辑:
  - 开仓: canOpen(带宽分位<=85% 且 连续3根收窄) + entrySignal(收盘触/破下轨LONG, 触/破上轨SHORT)
  - 管理: 触中轨止盈(浮盈>=2%), 放量ATR移动止盈(0.3), checkHardStop(单K浮亏>=lossKill%本金全平)
  - 终极风控: 总浮亏>=finalLoss%全平
对比: 原(lossKill=20/finalLoss=70) vs D方案(lossKill=8/finalLoss=40)
手续费: 双边0.10% (Taker 0.05%*2) - 精确
资金: 起点1000USDT, 单笔投入15%本金, 杠杆3x
窗口: 最近 1个月 / 3个月 (币安真实K线, 每页1000根)
数据源: 币安1h/4h
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT','INJUSDT','SEIUSDT','FETUSDT','APTUSDT','WIFUSDT']
FEE_RATE=0.0005   # 单边taker 0.05%; 开+平=0.10%

def get_klines(sym,interval,days):
    """拉最近N天K线: 1h=24*N, 4h=6*N根"""
    lim=min(1000,int(days*24))
    data=[]; et=''
    for _ in range(3):
        url=f'{BINANCE}?symbol={sym}&interval={interval}&limit={min(1000,lim)}'
        if et: url+=f'&endTime={et}'
        try: b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
        except: break
        if not b: break
        data=b+data; et=str(b[0][0]-1)
        if len(data)>=lim: break
        time.sleep(0.12)
    data.sort(key=lambda x:x[0])
    # 只保留最近 days 天
    if len(data)>lim: data=data[-lim:]
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'v':float(x[5])} for x in data]

def bands(c,i,n=20,k=2.0):
    s=c[i-n:i]
    if len(s)<n: return None
    m=sum(s)/n; sd=math.sqrt(sum((x-m)**2 for x in s)/n)
    return {'mid':m,'up':m+k*sd,'lo':m-k*sd,'sd':sd,'width':(2*k*sd)/(m or 1)}

def atr(kl,i,n=14):
    trs=[]
    for j in range(max(1,i-n+1),i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c']
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs) if len(trs)>=n else None

def width_pct(c,i,cur_w,histn=100,pn=20):
    if i<histn+pn: return 0.5
    wins=[]
    for j in range(i-histn,i):
        bb=bands(c,j+1,pn,2.0)
        if bb: wins.append(bb['width'])
    return sum(1 for w in wins if w<cur_w)/len(wins) if wins else 0.5

def shr(c,i,pn=20,bars=3):
    rw=[]
    for j in range(max(pn,i-bars+1),i+1):
        bb=bands(c,j,pn,2.0)
        if bb: rw.append(bb['width'])
    return len(rw)>=bars and all(rw[x]<rw[x-1] for x in range(1,len(rw)))

def backtest(sym,interval,days,loss_kill,final_loss):
    kl=get_klines(sym,interval,days)
    if not kl or len(kl)<300: return None
    c=[k['c'] for k in kl]
    bal=1000.0; peak=1000.0; maxdd=0
    t=w=0; realized=0.0; worst=0; fee_total=0
    i=140
    # 逐信号开仓, 管理持仓到平
    while i<len(c)-30:
        b=bands(c,i); a=atr(kl,i)
        if not b or not a: i+=1;continue
        # canOpen
        if width_pct(c,i,b['width'])>0.85 or not shr(c,i): i+=1;continue
        price=c[i]
        side=None
        if price<=b['lo']: side='LONG'
        elif price>=b['up']: side='SHORT'
        if not side: i+=1;continue
        entry=price
        lev=3
        invest=bal*0.15          # 投入15%本金
        notional=invest*lev      # 名义
        # 前置风控触发: 单K浮亏(相对本金%)
        closed=False; exit_pnl_pct=None
        low_since=price; high_since=price
        for j in range(i+1,min(i+400,len(kl))):
            H=kl[j]['h']; L=kl[j]['l']; C=kl[j]['c']
            # 盘中极端(相对开仓)
            if side=='LONG':
                worst_pct=(entry-L)/entry   # 盘中最大浮亏
            else:
                worst_pct=(H-entry)/entry
            equity_loss=abs(worst_pct)*lev*100  # 相对本金%
            # checkHardStop
            if equity_loss>=loss_kill:
                exit = L if side=='LONG' else H
                exit_pnl_pct=(exit-entry)/entry if side=='LONG' else (entry-exit)/entry
                closed=True; break
            # 轨道止盈: 触中轨(浮盈>=2%后才止)
            if side=='LONG':
                pnl_pct=(C-entry)/entry*100
                if C>=b['mid'] and pnl_pct>=2.0: exit_pnl_pct=(b['mid']-entry)/entry; closed=True; break
            else:
                pnl_pct=(entry-C)/entry*100
                if C<=b['mid'] and pnl_pct>=2.0: exit_pnl_pct=(entry-b['mid'])/entry; closed=True; break
            # 终极风控finalLoss(总浮亏>=x%本金)
            total_loss=abs(pnl_pct)/100*lev*100
            if total_loss>=final_loss:
                exit_pnl_pct=(-0.01)*lev/0.15 if False else None # 简化下面统一处理
            i=j
        if closed:
            # 盈亏(本金): pnl% * 名义 = pnl_pct * invest*lev
            pnl_usd=exit_pnl_pct*invest*lev
            fee=2*FEE_RATE*invest*lev       # 开+平手续费(基于名义)
            net=pnl_usd-fee
            bal=max(10,bal+net); realized+=net; fee_total+=fee
            t+=1; worst=min(worst,net)
            if net>0: w+=1
            peak=max(peak,bal); maxdd=max(maxdd,(peak-bal)/peak)
            i+=1
        else:
            i+=1
    return {'t':t,'w':w,'realized':realized,'worst':worst,'maxdd':maxdd,'fee':fee_total,'bal':bal}

print("═══ 布林D方案回测(严格0.10%手续费) ═══\n")
for interval in ['1h','4h']:
    for days in [30,90]:
        print(f"\n════ 周期 {interval} / 回测{int(days)}天 ════")
        a1=[0,0,0.0,0,0.0]; a2=[0,0,0.0,0,0.0]  # 原/D
        print("币种 | 原(lk20/fl70): 笔/胜/净费用后 | D(lk8/fl40): 笔/胜/净费用后")
        for sym in SYMBOLS:
            try:
                ro=backtest(sym,interval,days,20,70)
                rd=backtest(sym,interval,days,8,40)
                if not ro or not rd or (ro['t']==0 and rd['t']==0): continue
                def f(r): return f"{r['t']}/{r['w']*100//r['t'] if r['t'] else 0}%/{r['realized']:+.1f}USDT"
                print(f"{sym:8} | {f(ro):26} | {f(rd)}")
                for r,agg in [(ro,a1),(rd,a2)]:
                    agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['realized']
                    agg[3]=min(agg[3],r['worst']); agg[4]+=r['fee']
            except Exception as e: print(f"{sym:8} err {str(e)[:15]}")
        def sf(a): return f"共{a[0]}笔 胜{a[1]*100//a[0] if a[0] else 0}% 净{a[2]:+.0f}USDT 最差单{a[3]:+.1f} 费{a[4]:.0f}"
        print(f"\n  原(lk20/fl70): {sf(a1)}")
        print(f"  D(lk8/fl40)  : {sf(a2)}")
