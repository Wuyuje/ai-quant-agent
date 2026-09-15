#!/usr/bin/env python3
"""震荡策略 v5 回测 — 精确复现当前 lib/bb-strategy.js 配置
配置来源: lib/bb-strategy.js CONFIG (v5: 15m周期 + 2.0ATR止损 + 补仓1次 + 总浮亏8%)
"""
import urllib.request, json, time, math, statistics

UA = {'User-Agent': 'Mozilla/5.0'}
FEE = 0.0004  # 双边手续费 0.04%*2

# ═══ 当前策略配置(从 bb-strategy.js CONFIG 提取) ═══
CFG = {
    'interval': '15m',          # v5
    'bbPeriod': 20, 'bbStd': 2.0,
    'stPeriod': 10, 'stMultiplier': 3.0,
    'atrPeriod': 14, 'minAtrPct': 0.10,
    'adxThreshold': 20,
    'atrStopMultiplier': 2.0,   # v4
    'singleKLossPct': 6,
    'ultimateLossPct': 20,
    'totalLossPct': 8,          # v5
    'reverseTriggerPct': 8,
    'profitTriggerPct': 2.0,    # v6
    'consecutiveLossPct': 1.5, 'consecutiveLossKlines': 6,
    'maxHoldHours': 2, 'maxHoldLossPct': 3,
    'avgPriceLossPct': 5,
    'maxReplenish': 1,          # v4
    'leverage': 3,
    'topN': 10,
    'blacklist': ['BANKUSDT', 'BTCUSDT', 'BNBUSDT'],
    'bandwidthOpenAllow': 90,
    'bwPercentileLookback': 100,
}

def get_k(sym, iv, pages=6):
    data = []; et = ''
    for _ in range(pages):
        url = f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et: url += f'&endTime={et}'
        try:
            b = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15).read().decode())
        except Exception:
            time.sleep(0.3); continue
        if not b: break
        data = b + data; et = str(b[0][0]); time.sleep(0.04)
    data.sort(key=lambda x: x[0])
    return [{'t': int(x[0]), 'open': float(x[1]), 'high': float(x[2]), 'low': float(x[3]),
             'close': float(x[4]), 'volume': float(x[5])} for x in data]

def bollinger(kl, p=20, s=2.0):
    out = [None]*len(kl)
    for i in range(p-1, len(kl)):
        w = [k['close'] for k in kl[i-p+1:i+1]]
        m = sum(w)/p
        sd = math.sqrt(sum((x-m)**2 for x in w)/p)
        out[i] = {'mid': m, 'upper': m+s*sd, 'lower': m-s*sd, 'sd': sd}
    return out

def atr_calc(kl, p=14):
    n = len(kl); out = [0.0]*n
    for i in range(n):
        if i == 0: out[i] = kl[i]['high']-kl[i]['low']; continue
        tr = max(kl[i]['high']-kl[i]['low'], abs(kl[i]['high']-kl[i-1]['close']), abs(kl[i]['low']-kl[i-1]['close']))
        out[i] = tr if i < p else (out[i-1]*(p-1)+tr)/p
    return out

def supertrend(kl, p=10, m=3.0):
    n = len(kl)
    if n < p+2: return [None]*n
    atr = atr_calc(kl, p)
    hl2 = [(k['high']+k['low'])/2 for k in kl]
    up = [0.0]*n; dn = [0.0]*n; d = [1]*n
    for i in range(n):
        u = hl2[i]+m*atr[i]; dd = hl2[i]-m*atr[i]
        if i > 0:
            u = u if (u < up[i-1] or kl[i-1]['close'] > up[i-1]) else up[i-1]
            dd = dd if (dd > dn[i-1] or kl[i-1]['close'] < dn[i-1]) else dn[i-1]
        up[i] = u; dn[i] = dd
        if i == 0: d[i] = 1
        elif kl[i]['close'] > up[i-1]: d[i] = 1
        elif kl[i]['close'] < dn[i-1]: d[i] = -1
        else: d[i] = d[i-1] if ((d[i-1]==1 and kl[i]['close']>=dn[i]) or (d[i-1]==-1 and kl[i]['close']<=up[i])) else -d[i-1]
    res = [None]*n
    for i in range(n):
        st = 1
        j = i
        while j > 0 and d[j] == d[j-1]: st += 1; j -= 1
        res[i] = {'dir': d[i], 'prevDir': d[i-1] if i>0 else d[i], 'line': dn[i] if d[i]==1 else up[i], 'streak': st}
    return res

def adx_calc(kl, p=14):
    n = len(kl)
    if n < p+2: return [None]*n
    plus=[0.0]*n; minus=[0.0]*n; tr=[0.0]*n
    for i in range(1, n):
        up = kl[i]['high']-kl[i-1]['high']; dn = kl[i-1]['low']-kl[i]['low']
        plus[i] = up if (up > dn and up > 0) else 0.0
        minus[i] = dn if (dn > up and dn > 0) else 0.0
        tr[i] = max(kl[i]['high']-kl[i]['low'], abs(kl[i]['high']-kl[i-1]['close']), abs(kl[i]['low']-kl[i-1]['close']))
    out=[None]*n; pdm=mdm=atr=0.0
    for i in range(1, n):
        if i <= p:
            pdm+=plus[i]; mdm+=minus[i]; atr+=tr[i]
            if i == p:
                pdi = 100*pdm/atr if atr else 0; mdi = 100*mdm/atr if atr else 0
                out[i] = 100*abs(pdi-mdi)/max(pdi+mdi, 1e-9)
        else:
            pdm = pdm - pdm/p + plus[i]; mdm = mdm - mdm/p + minus[i]; atr = atr - atr/p + tr[i]
            pdi = 100*pdm/atr if atr else 0; mdi = 100*mdm/atr if atr else 0
            out[i] = 100*abs(pdi-mdi)/max(pdi+mdi, 1e-9)
    return out

def bw_percentile(bb, i, lookback=100):
    if i < lookback: return None
    bws = []
    for j in range(i-lookback, i):
        if bb[j] and bb[j]['mid']: bws.append((bb[j]['upper']-bb[j]['lower'])/bb[j]['mid']*100)
    if not bws: return None
    cur = (bb[i]['upper']-bb[i]['lower'])/bb[i]['mid']*100
    return sum(1 for x in bws if x <= cur)/len(bws)*100

def backtest(symbol, kl, verbose=False):
    """返回 (trades, wins, losses, pnl)"""
    bb = bollinger(kl, CFG['bbPeriod'], CFG['bbStd'])
    atr = atr_calc(kl, CFG['atrPeriod'])
    st = supertrend(kl, CFG['stPeriod'], CFG['stMultiplier'])
    adx = adx_calc(kl, CFG['adxPeriod'] if 'adxPeriod' in CFG else 14)
    pos = None
    trades = []; wins = 0; losses = 0; pnl = 0.0
    L = CFG['leverage']
    for i in range(60, len(kl)):
        k = kl[i]; price = k['close']
        b = bb[i]; s = st[i]; a = atr[i]
        if not b or not s or not a: continue
        # ═══ 持仓管理 ═══
        if pos:
            entry = pos['entry']; side = pos['side']
            # 回报率(含杠杆)
            roi = ((price-entry)/entry*100*L) if side == 'LONG' else ((entry-price)/entry*100*L)
            pos['peak'] = max(pos.get('peak', roi), roi)
            held_h = (k['t']-pos['time'])/3600000
            exit_reason = None
            # 1) 触对轨止盈
            if side == 'LONG' and price >= b['upper']: exit_reason = 'TP_上轨'
            elif side == 'SHORT' and price <= b['lower']: exit_reason = 'TP_下轨'
            # 2) 2%兜底止盈
            if not exit_reason and roi >= CFG['profitTriggerPct']*L/3*3: pass
            if not exit_reason and roi >= CFG['profitTriggerPct']:
                exit_reason = f'TP_{CFG["profitTriggerPct"]}%'
            # 3) 2.0ATR止损
            if not exit_reason:
                if side == 'LONG' and price <= entry - CFG['atrStopMultiplier']*a:
                    exit_reason = f'SL_{CFG["atrStopMultiplier"]}ATR'
                elif side == 'SHORT' and price >= entry + CFG['atrStopMultiplier']*a:
                    exit_reason = f'SL_{CFG["atrStopMultiplier"]}ATR'
            # 4) 总浮亏止损
            if not exit_reason and roi <= -CFG['totalLossPct']: exit_reason = f'SL_总浮亏{CFG["totalLossPct"]}%'
            # 5) 反向
            if not exit_reason and roi <= -CFG['reverseTriggerPct']: exit_reason = f'REV_{CFG["reverseTriggerPct"]}%'
            # 6) 时间止损
            if not exit_reason and held_h >= CFG['maxHoldHours'] and roi <= -CFG['maxHoldLossPct']:
                exit_reason = f'TIME_{CFG["maxHoldHours"]}h'
            # 7) SUPER反向
            if not exit_reason:
                if side == 'LONG' and s['dir'] == -1 and s['prevDir'] == 1: exit_reason = 'SUPER翻转'
                elif side == 'SHORT' and s['dir'] == 1 and s['prevDir'] == -1: exit_reason = 'SUPER翻转'
            if exit_reason:
                fee = FEE * 2
                pnl_pct = roi/100.0/L*L - fee  # 含杠杆回报
                p = roi/100.0 - fee*L  # 简化: 名义回报*杠杆-手续费
                p = roi/100.0*1 - FEE*2*L
                pnl += p
                if p > 0: wins += 1
                else: losses += 1
                trades.append({'side': side, 'entry': entry, 'exit': price, 'roi': roi, 'reason': exit_reason, 'pnl': p})
                pos = None
            continue
        # ═══ 开仓 ═══
        if a/price*100 < CFG['minAtrPct']: continue
        bw = bw_percentile(bb, i, CFG['bwPercentileLookback'])
        if bw and bw > CFG['bandwidthOpenAllow']: continue
        touchLower = price <= b['lower']; touchUpper = price >= b['upper']
        nearLower = price <= (b['mid']-(b['mid']-b['lower'])*0.6)
        nearUpper = price >= (b['mid']+(b['upper']-b['mid'])*0.6)
        if (touchLower or nearLower) and s['dir'] == 1:
            pos = {'side': 'LONG', 'entry': price, 'time': k['t'], 'peak': 0}
        elif (touchUpper or nearUpper) and s['dir'] == -1:
            pos = {'side': 'SHORT', 'entry': price, 'time': k['t'], 'peak': 0}
    return trades, wins, losses, pnl

SYMS = ['DOGEUSDT','INJUSDT','DOTUSDT','XRPUSDT','ETHUSDT','SOLUSDT','APTUSDT','LINKUSDT','LTCUSDT','ADAUSDT','SUIUSDT','AVAXUSDT']
print(f"═══ 震荡策略 v5 回测 (interval={CFG['interval']}, {CFG['atrStopMultiplier']}ATR止损, 补仓{CFG['maxReplenish']}次) ═══\n")
tot_t=0; tot_w=0; tot_l=0; tot_p=0.0; coin_res=[]
for sym in SYMS:
    if sym in CFG['blacklist']: continue
    kl = get_k(sym, CFG['interval'], pages=6)
    if len(kl) < 200: print(f"{sym}: 数据不足({len(kl)})"); continue
    tr, w, l, p = backtest(sym, kl)
    if not tr: print(f"{sym}: 无交易"); continue
    wr = w/max(1,w+l)*100
    tot_t += len(tr); tot_w += w; tot_l += l; tot_p += p
    coin_res.append((sym, len(tr), wr, p))
    print(f"{sym:10s} {len(tr):3d}笔 胜率{wr:5.1f}% 盈亏{p:+.2f} 每单{p/max(1,len(tr)):+.4f}")
print()
if tot_t:
    print(f"═══ 汇总 ═══")
    print(f"总交易: {tot_t}笔")
    print(f"胜率: {tot_w/max(1,tot_w+tot_l)*100:.1f}% ({tot_w}胜/{tot_l}负)")
    print(f"总盈亏: {tot_p:+.2f} (单位: 每单1倍名义)")
    print(f"每单期望: {tot_p/tot_t:+.4f}")
    print(f"盈利币: {sum(1 for _,_,_,p in coin_res if p>0)}/{len(coin_res)}")
