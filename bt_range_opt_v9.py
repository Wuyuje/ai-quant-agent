#!/usr/bin/env python3
"""震荡策略优化回测 — 测试不同离场方案
核心问题: SUPER翻转离场879笔0%胜率, 吃掉全部利润
"""
import urllib.request, json, time, math
exec(open("/app/workspace/ai-quant-agent/bt_range_v5_current.py").read().split("SYMS = [")[0])

SYMS = ['DOGEUSDT','ETHUSDT','SOLUSDT','ADAUSDT','XRPUSDT','DOTUSDT','APTUSDT','LINKUSDT','LTCUSDT','SUIUSDT','AVAXUSDT','INJUSDT']

def bt(sym, kl, opt):
    bb = bollinger(kl, CFG['bbPeriod'], CFG['bbStd'])
    atr = atr_calc(kl, CFG['atrPeriod'])
    st = supertrend(kl, CFG['stPeriod'], CFG['stMultiplier'])
    pos = None; trades = []; pnl = 0.0
    L = CFG['leverage']
    for i in range(60, len(kl)):
        k = kl[i]; price = k['close']
        b = bb[i]; s = st[i]; a = atr[i]
        if not b or not s or not a: continue
        if pos:
            entry = pos['entry']; side = pos['side']
            roi = ((price-entry)/entry*100*L) if side=='LONG' else ((entry-price)/entry*100*L)
            pos['peak'] = max(pos.get('peak', roi), roi)
            held_h = (k['t']-pos['time'])/3600000
            er = None
            # 止盈
            if side=='LONG' and price >= b['upper']: er='TP上轨'
            elif side=='SHORT' and price <= b['lower']: er='TP下轨'
            if not er and roi >= opt['tp']: er='TP兜底'
            # 止损
            if not er:
                if side=='LONG' and price <= entry-opt['atr_sl']*a: er='SL_ATR'
                elif side=='SHORT' and price >= entry+opt['atr_sl']*a: er='SL_ATR'
            if not er and roi <= -opt['total_sl']: er='SL_总浮亏'
            if not er and held_h >= opt['max_h'] and roi <= -opt['time_sl']: er='TIME'
            # SUPER离场(可配置)
            if not er and opt.get('super_exit'):
                # 只在SUPER反向且已亏损时才离场
                if side=='LONG' and s['dir']==-1 and roi < opt.get('super_min_roi',-999): er='SUPER'
                elif side=='SHORT' and s['dir']==1 and roi < opt.get('super_min_roi',-999): er='SUPER'
            if er:
                p = roi/100.0 - FEE*2*L
                pnl += p
                trades.append({'side':side,'roi':roi,'reason':er,'pnl':p})
                pos=None
            continue
        # 开仓
        if a/price*100 < CFG['minAtrPct']: continue
        bw = bw_percentile(bb, i, CFG['bwPercentileLookback'])
        if bw and bw > CFG['bandwidthOpenAllow']: continue
        tL = price<=b['lower']; tU = price>=b['upper']
        nL = price<=(b['mid']-(b['mid']-b['lower'])*0.6); nU = price>=(b['mid']+(b['upper']-b['mid'])*0.6)
        if (tL or nL) and s['dir']==1: pos={'side':'LONG','entry':price,'time':k['t'],'peak':0}
        elif (tU or nU) and s['dir']==-1: pos={'side':'SHORT','entry':price,'time':k['t'],'peak':0}
    return trades, pnl

def run_all(name, opt):
    T=0; W=0; L=0; P=0.0; coins=[]
    for sym in SYMS:
        if sym in CFG['blacklist']: continue
        kl = get_k(sym, CFG['interval'], pages=6)
        if len(kl)<200: continue
        tr, p = bt(sym, kl, opt)
        if not tr: continue
        w = sum(1 for t in tr if t['pnl']>0)
        T+=len(tr); W+=w; L+=len(tr)-w; P+=p
        coins.append((sym, len(tr), 100*w/len(tr), p))
    print(f"\n【{name}】")
    if T:
        print(f"  {T}笔 胜率{100*W/T:.1f}% 盈亏{P:+.2f} 每单{P/T:+.4f} 盈利币{sum(1 for _,_,_,p in coins if p>0)}/{len(coins)}")
    return P

print("═══ 震荡策略离场方案对比 (15m, 12币, 真实币安数据) ═══")

# 基准: 当前v5
run_all("当前v5 (SUPER无条件离场)", {'tp':2.0*3,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3,'super_exit':True,'super_min_roi':-999})

# 方案A: 完全去掉SUPER离场
run_all("方案A: 去掉SUPER离场", {'tp':2.0*3,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3,'super_exit':False})

# 方案B: SUPER只在小亏时离场(>-3%才走, 大亏继续持有等反弹)
run_all("方案B: SUPER仅在ROI>-5%时离场", {'tp':2.0*3,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3,'super_exit':True,'super_min_roi':-5})

# 方案C: 去掉SUPER + 放宽止盈
for tp in [3,4,5,6]:
    run_all(f"方案C: 无SUPER离场 + 止盈{tp}%", {'tp':tp,'atr_sl':2.0,'total_sl':8,'max_h':2,'time_sl':3,'super_exit':False})

# 方案D: 无SUPER + 收紧止损
for sl in [1.5,2.0,2.5,3.0]:
    run_all(f"方案D: 无SUPER离场 + {sl}ATR止损", {'tp':6,'atr_sl':sl,'total_sl':8,'max_h':2,'time_sl':3,'super_exit':False})

# 方案E: 最优组合搜索
best=(None,-999)
for tp in [4,5,6,8]:
    for sl in [1.5,2.0,2.5]:
        for tsl in [6,8,10]:
            tr_all=[];p_all=0.0
            for sym in SYMS:
                if sym in CFG['blacklist']: continue
                kl = get_k(sym, CFG['interval'], pages=6)
                if len(kl)<200: continue
                t,p = bt(sym,kl,{'tp':tp,'atr_sl':sl,'total_sl':tsl,'max_h':2,'time_sl':3,'super_exit':False})
                tr_all+=t; p_all+=p
            if p_all>best[1]: best=((tp,sl,tsl),p_all,len(tr_all))
print(f"\n═══ 最优组合 ═══")
print(f"  止盈{best[0][0]}% + {best[0][1]}ATR止损 + 总浮亏{best[0][2]}% → 盈亏{best[1]:+.2f} ({best[2]}笔)")
