#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""D方案回测 v2 - 严格仓位/收益数学
对比两种配置(每币独立):
  A) 原配置: 投入15%本金, 杠杆3x, 前置风控lossKill=20%本金
  B) D方案:  投入15%本金, ATR动态杠杆(单K ATR波动=3%本金), 前置风控lossKill=8%本金
收益模型: 每笔 pnl_USD = 价格变动% * 杠杆 * 投入金额 → 累加到本金
开仓(布林正向): 触下轨LONG / 触上轨SHORT(收盘穿过), canOpen=带宽分位<=85%且连续3根收窄
管理: 触中轨止盈 / 单K浮亏>=lossKill%本金 → 前置风控平
  简化: 不加仓(聚焦风控阈值对尾亏影响), 每笔批价用后续K
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT','INJUSDT','SEIUSDT','FETUSDT']
FEE=0.002

def get_klines(sym,interval,pages=5):
    data=[];et=''
    for _ in range(pages):
        url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
        if et: url+=f'&endTime={et}'
        try: b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
        except: break
        if not b: break
        data=b+data;et=str(b[0][0]);time.sleep(0.13)
    data.sort(key=lambda x:x[0])
    return [{'h':float(x[2]),'l':float(x[3]),'c':float(x[4])} for x in data]

def bands(c,i,n=20,k=2.0):
    s=c[i-n:i]
    if len(s)<n: return None
    m=sum(s)/n;sd=math.sqrt(sum((x-m)**2 for x in s)/n)
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
    if len(rw)<bars: return False
    return all(rw[x]<rw[x-1] for x in range(1,len(rw)))

def backtest(sym,interval,cfg):
    """cfg: {invest_frac, lev_fixed, use_atr_sizing, atr_risk_pct, loss_kill}
    返回 {t,w,ret_pct,worst_pct,maxdd}
    """
    kl=get_klines(sym,interval)
    if not kl or len(kl)<500: return None
    c=[k['c'] for k in kl]
    bal=1000.0; peak=1000.0; maxdd=0
    t=w=0; tot_ret=0.0; worst=0
    i=120
    while i<len(c)-30:
        b=bands(c,i); a=atr(kl,i)
        if not b or not a: i+=1;continue
        if width_pct(c,i,b['width'])>0.85 or not shr(c,i): i+=1;continue
        price=c[i]
        side=None
        if price<=b['lo']: side='LONG'
        elif price>=b['up']: side='SHORT'
        if not side: i+=1;continue
        entry=price
        # 杠杆
        if cfg['use_atr_sizing'] and a>0:
            atr_pct=a/price
            lev=min(20,cfg['atr_risk_pct']/100.0/atr_pct)  # 单ATR波动=atr_risk%本金
        else:
            lev=cfg['lev_fixed']
        invest=bal*cfg['invest_frac']       # 投入本金金额
        # 组合: 前置风控触发线(相对本金%) → 价格变动%对应
        loss_kill=cfg['loss_kill']          # %本金
        # 逐K管理
        closed=False; exit_price=None; reason=None
        tp=price  # 触中轨
        for j in range(i+1,min(i+300,len(kl))):
            H=kl[j]['h']; L=kl[j]['l']; C=kl[j]['c']
            # 盘中单K极端浮亏(相对开仓): LONG用L, SHORT用H
            if side=='LONG':
                worst_pct=(entry-L)/entry
            else:
                worst_pct=(H-entry)/entry
            equity_loss=abs(worst_pct)*lev*100  # 相对本金%
            if equity_loss>=loss_kill:
                # 前置风控平仓, 用盘中最差价估算
                exit_price = L if side=='LONG' else H
                reason='hardstop'; closed=True; break
            # 轨道止盈: 顺向触中轨(SHORT等回落, LONG逻辑)
            if side=='LONG' and C>=b['mid']:
                exit_price=C; reason='tp_mid'; closed=True; break
            if side=='SHORT' and C<=b['mid']:
                exit_price=C; reason='tp_mid'; closed=True; break
            # 轨道内安全区间持有
            i=j
        if closed:
            if side=='LONG': pnl_pct=(exit_price-entry)/entry
            else: pnl_pct=(entry-exit_price)/entry
            pnl_usd=pnl_pct*lev*invest
            fee=2*FEE*invest*lev
            net=pnl_usd-fee
            bal+=net; tot_ret+=net/1000*100
            t+=1; worst=min(worst,net/1000*100)
            if net>0: w+=1
            peak=max(peak,bal); maxdd=max(maxdd,(peak-bal)/peak)
            i+=1
        else:
            i+=1
    return {'t':t,'w':w,'ret_pct':tot_ret,'worst':worst,'maxdd':maxdd}

CFG_A={'invest_frac':0.15,'lev_fixed':3,'use_atr_sizing':False,'atr_risk_pct':10,'loss_kill':20}
CFG_B={'invest_frac':0.15,'lev_fixed':3,'use_atr_sizing':True,'atr_risk_pct':3,'loss_kill':8}

print("═══ 布林正向: 原配置A vs D方案B (严格仓位数学) ═══\n")
for interval in ['5m','1h','4h']:
    aggA=[0,0,0.0,0]; aggB=[0,0,0.0,0]
    print(f"\n── 周期 {interval} ──")
    print("币种 | A(15%*3x,lk20): 笔/胜/总% | B(ATR控仓,lk8): 笔/胜/总%")
    for sym in SYMBOLS:
        try:
            ra=backtest(sym,interval,CFG_A); rb=backtest(sym,interval,CFG_B)
            if not ra or not rb or ra['t']==0: continue
            def f(r): return f"{r['t']}/{r['w']*100//r['t']}%/{r['ret_pct']:+.1f}%"
            for r,agg in [(ra,aggA),(rb,aggB)]:
                agg[0]+=r['t'];agg[1]+=r['w'];agg[2]+=r['ret_pct'];agg[3]=min(agg[3],r['worst'])
            print(f"{sym:8} | {f(ra):22} | {f(rb)}")
        except Exception as e: print(f"{sym:8} err {str(e)[:15]}")
    def sf(agg): return f"共{agg[0]}笔 胜{agg[1]*100//agg[0] if agg[0] else 0}% 总{agg[2]:+.1f}% 最差单{agg[3]:+.1f}%"
    print(f"\n  原配置A : {sf(aggA)}")
    print(f"  D方案B  : {sf(aggB)}")