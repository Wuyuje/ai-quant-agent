#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""反向开仓回测 - 修正出场顺序bug版
反向: 触上轨(价>=上轨)→做多(SHORT的反面), 触下轨(价<=下轨)→做空
对比两种触发: A)收盘触轨  B)当根K线穿轨(盘中最高/最低穿过, 收盘可拉回)
出场(按用户: 止盈止损不改, 用现有布林的反向): 
  用现有 checkTakeProfit(checkHardStop) 思想的反向镜像:
  多单(触上轨开): 止盈=回中轨/触下轨, 止损=继续冲高突破
  但先简化用对称固定 0.5-1.5ATR 止盈 + 1-2ATR 止损, 修正出场顺序
扣0.2%费, 严格验证
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT','INJUSDT']
FEE=0.002

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
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4])} for x in data]

def bands(c,i,n=20,k=2.0):
    s=c[i-n:i]
    if len(s)<n: return None
    m=sum(s)/n; sd=math.sqrt(sum((x-m)**2 for x in s)/n)
    return {'mid':m,'up':m+k*sd,'lo':m-k*sd,'sd':sd}

def atr(kl,i,n=14):
    trs=[]
    for j in range(max(1,i-n+1),i+1):
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c']
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs) if len(trs)>=n else None

def backtest(sym,interval,trigger,tp_mul,stop_mul):
    """反向开仓
    trigger: 'close'=收盘触轨; 'sweep'=盘中穿轨(high>=up or low<=lo)
    反向: up处开LONG(等回落), lo处开SHORT(等反弹)
    出场: 多单 profit=回落(downward), 空单 profit=反弹(upward)
    多单: 止盈=盘中低点<=mid附近? 简化用 price-tp_mul*atr (多单赚回落); 止损=price+stop_mul*atr(冲高)
    空单: 止盈=price+tp_mul*atr (赚反弹); 止损=price-stop_mul*atr(下杀)
    同一根内先判止损(保守, 避免把亏损记成盈利)
    """
    kl=get_klines(sym,interval)
    if not kl or len(kl)<300: return None
    c=[k['c'] for k in kl]
    t=w=0;ret=0.0
    i=40
    while i<len(c)-30:
        b=bands(c,i); a=atr(kl,i)
        if not b or not a: i+=1;continue
        hi=kl[i]['h']; lo=kl[i]['l']; close=kl[i]['c']; o=kl[i]['o']
        sig=None
        if trigger=='close':
            if close>=b['up']: sig='LONG'      # 收盘穿/触上轨→做多(反向)
            elif close<=b['lo']: sig='SHORT'   # 收盘穿/触下轨→做空(反向)
        else:  # sweep 盘中穿
            if hi>=b['up']: sig='LONG'         # 高点上穿→做多
            elif lo<=b['lo']: sig='SHORT'      # 低点下穿→做空
        if not sig: i+=1;continue
        entry=close
        # 出场: 多单赚回落(向m.id), 空单赚反弹(向m.id)
        if sig=='LONG':
            tp=entry - tp_mul*a   # 回落止盈
            stop=entry + stop_mul*a  # 冲高止损
            carried=False; pnl=0
            for j in range(i+1,min(i+300,len(kl))):
                H=kl[j]['h']; L=kl[j]['l']
                # 先判止损(保守顺序): 先冲高被损记亏损
                if H>=stop: pnl=(stop-entry)/(entry or 1); carried=True; break
                if L<=tp: pnl=(tp-entry)/(entry or 1); carried=True; break
        else:
            tp=entry + tp_mul*a   # 反弹止盈
            stop=entry - stop_mul*a  # 下杀止损
            carried=False; pnl=0
            for j in range(i+1,min(i+300,len(kl))):
                H=kl[j]['h']; L=kl[j]['l']
                if L<=stop: pnl=(entry-stop)/(entry or 1); carried=True; break
                if H>=tp: pnl=(entry-tp)/(entry or 1); carried=True; break
        if carried:
            pnl-=2*FEE; ret+=pnl; t+=1
            if pnl>0: w+=1
            i=j+1
        else:
            i+=1
    return {'t':t,'w':w,'ret':ret}

print("═══ 反向开仓回测(修正出场顺序) 触发∈收盘触轨/盘中穿轨 ═══\n")
for trigger_name,trigger in [('收盘触轨','close'),('盘中穿轨','sweep')]:
    print(f"\n========== 触发方式: {trigger_name} ==========")
    for interval in ['1h','4h']:
        print(f"\n  ── 周期 {interval} ──")
        combos=[]
        for stop_mul in [1.0,1.5,2.0]:
            for tp_mul in [0.5,0.8,1.0,1.5]:
                agg=[0,0,0.0]
                for sym in SYMBOLS:
                    try:
                        r=backtest(sym,interval,trigger,tp_mul,stop_mul)
                        if r and r['t']: agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['ret']
                    except: pass
                if agg[0]:
                    per=agg[2]/agg[0]; wr=agg[1]*100/agg[0]
                    combos.append((f'盈{tp_mul}ATR/损{stop_mul}ATR',wr,per,agg[0],agg[2]))
        combos.sort(key=lambda x:-x[2])
        print(f"  {'组合':24} {'胜率':>6} {'每笔%':>9} {'笔数':>5} {'总%':>8}")
        for name,wr,per,cnt,tr in combos:
            flag='✅' if per>0 else '❌'
            print(f"  {name:24} {wr:5.1f}% {100*per:+8.3f}% {cnt:5d} {100*tr:+7.1f}% {flag}")
