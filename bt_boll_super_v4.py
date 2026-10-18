#!/usr/bin/env python3
"""布林均值回归 + SUPERTREND 组合策略回测 (v4)
入场: 触/近布林轨(均值回归) + SUPERTREND 同向
出场: 2%止盈 / 2ATR止损 / 6%单笔止损 / 10%总止损
"""
import urllib.request, json, time, math

UA = {'User-Agent': 'Mozilla/5.0'}
FEE = 0.0005  # 单边费

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
        data = b + data; et = str(b[0][0]); time.sleep(0.06)
    data.sort(key=lambda x: x[0])
    return [{'t': int(x[0]), 'open': float(x[1]), 'high': float(x[2]), 'low': float(x[3]), 'close': float(x[4]), 'volume': float(x[5])} for x in data]

def supertrend(kl, period=10, mult=3.0):
    n = len(kl); hl2 = [(k['high']+k['low'])/2 for k in kl]
    atr = [0.0]*n
    for i in range(n):
        if i == 0: atr[i] = kl[i]['high']-kl[i]['low']; continue
        tr = max(kl[i]['high']-kl[i]['low'], abs(kl[i]['high']-kl[i-1]['close']), abs(kl[i]['low']-kl[i-1]['close']))
        atr[i] = tr if i < period else (atr[i-1]*(period-1)+tr)/period
    up=[0.0]*n; dn=[0.0]*n; dir=[1]*n
    for i in range(n):
        u=hl2[i]+mult*atr[i]; d=hl2[i]-mult*atr[i]
        if i>0:
            u = u if (u<up[i-1] or kl[i-1]['close']>up[i-1]) else up[i-1]
            d = d if (d>dn[i-1] or kl[i-1]['close']<dn[i-1]) else dn[i-1]
        up[i]=u; dn[i]=d
        if i==0: dir[i]=1
        elif kl[i]['close']>up[i-1]: dir[i]=1
        elif kl[i]['close']<dn[i-1]: dir[i]=-1
        else: dir[i] = (1 if kl[i]['close']>=dn[i] else -1) if dir[i-1]==1 else (-1 if kl[i]['close']<=up[i] else 1)
    return dir, atr

def bollinger(closes, period=20, k=2.0):
    if len(closes) < period: return None
    seg = closes[-period:]; mid = sum(seg)/period
    sd = math.sqrt(sum((x-mid)**2 for x in seg)/period) or 1e-9
    return {'mid': mid, 'upper': mid+k*sd, 'lower': mid-k*sd, 'bw': (2*k*sd)/mid}

def backtest(sym, kl, tp=2.0, sl_atr=2.0, max_loss=6.0, allow_flip=True):
    closes = [k['close'] for k in kl]
    dirs, atrs = supertrend(kl)
    pos = None
    trades = []; win = loss = 0; pnl_sum = 0.0
    for i in range(60, len(kl)-1):
        price = kl[i]['close']
        bb = bollinger(closes[:i+1], 20, 2.0)
        if not bb: continue
        atr = atrs[i]
        # 出场
        if pos:
            ep = pos['entry']; lev = 3.0
            pnl_pct = ((price-ep)/ep*100) if pos['side']=='LONG' else ((ep-price)/ep*100)
            roi = pnl_pct*lev
            exit_reason = None
            if pnl_pct >= tp: exit_reason = 'TP'
            elif atr and abs(price-ep) >= sl_atr*atr: exit_reason = 'ATR-SL'
            elif roi <= -max_loss: exit_reason = 'MAX-SL'
            if exit_reason:
                net = roi - FEE*lev*2*100  # 扣双边费(近似)
                trades.append(net)
                pnl_sum += net
                if net > 0: win += 1
                else: loss += 1
                pos = None
        # 入场
        if not pos:
            touchL = price <= bb['lower']; nearL = price <= bb['mid'] - (bb['mid']-bb['lower'])*0.6
            touchU = price >= bb['upper']; nearU = price >= bb['mid'] + (bb['upper']-bb['mid'])*0.6
            if (touchL or nearL) and dirs[i]==1:
                pos = {'side':'LONG','entry':price}
            elif (touchU or nearU) and dirs[i]==-1:
                pos = {'side':'SHORT','entry':price}
    tot = win+loss
    wr = round(win/tot*100,1) if tot else 0
    return {'sym':sym,'trades':tot,'win':win,'loss':loss,'wr':wr,'ret':round(pnl_sum,1)}

SYMS = ['ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','SUIUSDT','LINKUSDT','AVAXUSDT','ADAUSDT','NEARUSDT','APTUSDT','INJUSDT','LTCUSDT','DOTUSDT','UNIUSDT']
print("═══ 布林均值回归 + SUPERTREND 组合策略回测 (v4) ═══")
print("═══ 4h, 14币, FEE0.1%, TP2% / SL2ATR / MAXSL6% ═══\n")
trades=0; wins=0; ret=0.0
for s in SYMS:
    kl = get_k(s, '4h', 6)
    if len(kl) < 100:
        print(f"  {s:12s} 数据不足({len(kl)})"); continue
    r = backtest(s, kl)
    trades += r['trades']; wins += r['win']; ret += r['ret']
    flag = '🟢' if r['ret'] > 0 else '🔴'
    print(f"  {s:12s} {r['trades']:3d}笔 胜{r['wr']:5.1f}% 回报{r['ret']:+8.1f}% {flag}")
wr = round(wins/trades*100,1) if trades else 0
print(f"\n═══ 汇总: {trades}笔 胜率{wr}% 总回报{ret:+.1f}% ═══")
