#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Polymarket BTC 5分钟涨跌 · 币安共振 自动交易机器人（可实盘或 demo）
用法:
  DEMO=1 python3 polymarket_btc5_bot.py        # 只看方向/不下单（默认）
  DEMO=0 PK=你的私钥 python3 polymarket_btc5_bot.py
依赖: ccxt (币安公开K线), py-clob-client(可选, demo不需要)
"""
import os, time, math, datetime, json, sys

# ---------- 1) 币安信号：布林 + SUPER + RSI ----------
def binance_klines(interval="5m", limit=200):
    try:
        import ccxt
        ex = ccxt.binance({"enableRateLimit": True})
        kl = ex.fetch_ohlcv("BTC/USDT", interval, limit=limit)
        return [(k[1], k[2], k[3], k[4]) for k in kl]  # o,h,l,c
    except Exception as e:
        print("  [binance] 拉取失败:", e); return []

def rsi(cl, n=14):
    if len(cl) <= n: return 50
    g=l=0
    for i in range(len(cl)-n, len(cl)):
        d = cl[i]-cl[i-1]
        if d >= 0: g += d
        else: l -= d
    return 100 - 100/(1+ ((g/n)/(l/n) if l>0 else 1e9))

def supertrend(rows, p=10, m=3.0):
    c=[r[3] for r in rows]; hi=[r[1] for r in rows]; lo=[r[2] for r in rows]
    n=len(c); up=[0.0]*n; dn=[0.0]*n; st=[0.0]*n; dirs=[1]*n
    atr=[0.0]*n
    for i in range(1,n):
        tr=max(hi[i]-lo[i], abs(hi[i]-c[i-1]), abs(lo[i]-c[i-1]))
        atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else (atr[i-1]+tr)/i
    hl2=[(hi[i]+lo[i])/2 for i in range(n)]
    for i in range(n):
        u=hl2[i]+m*atr[i]; d=hl2[i]-m*atr[i]
        if i>0:
            u=u if (u<up[i-1] or c[i-1]>up[i-1]) else up[i-1]
            d=d if (d>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
        up[i]=u; dn[i]=d
    for i in range(1,n):
        if c[i]>up[i-1]: dirs[i]=1
        elif c[i]<dn[i-1]: dirs[i]=-1
        elif dirs[i-1]==1: dirs[i]=1 if c[i]>=dn[i] else -1
        else: dirs[i]=-1 if c[i]<=up[i] else 1
    return dirs[-1], up[-1], dn[-1]

def bounce_signal(rows):
    c=[r[3] for r in rows]
    n=len(c); seg=c[-20:]; mid=sum(seg)/20; sd=math.sqrt(sum((x-mid)**2 for x in seg)/20) or 1e-9
    bb_up=mid+2*sd; bb_dn=mid-2*sd; last=c[-1]; r=rsi(c)
    # 布林+RSI超卖/超买倾向
    return {"last":last, "bb_up":bb_up, "bb_dn":bb_dn, "rsi":r, "mid":mid}

def tech_direction(rows):
    """返回 (dir, strength)  dir∈{UP,DOWN} ; strength∈[0,1]"""
    st_dir, su, sd = supertrend(rows)
    bb = bounce_signal(rows)
    r = bb["rsi"]; last = bb["last"]
    score = 0.0
    # SUPER方向
    score += 1.5 if st_dir==1 else -1.5
    # 布林: 下轨下=超卖(偏反弹多), 上轨上=超买(偏空)
    if last <= bb["bb_dn"]: score += 1.0
    elif last >= bb["bb_up"]: score -= 1.0
    # RSI
    if r < 30: score += 1.0
    elif r > 70: score -= 1.0
    prefix = "UP" if score>=0 else "DOWN"
    strength = min(1.0, abs(score)/5.0)
    return prefix, strength

# ---------- 2) Polymarket 接入（真实或 demo）----------
def polymarket_probabilities():
    """返回 (p_up, p_down, ok)。真实实现需 token_id/market; demo 用占位0.5"""
    mode = os.getenv("DEMO", "1").strip()=="1"
    if mode:
        # DEMO: 取不到实时概率则用币安短趋势近似表示0.5+；真实接可用 py-clob-client 拉该轮 market 的 price
        return 0.5, 0.5, False
    # ---- 真实路径(你的 key 后开) ----
    try:
        from py_clob_client.client import ClobClient
        host="https://clob.polymarket.com"
        key=os.environ["PK"].strip()
        cc=ClobClient(host, key=key, chain_id=137)
        cc.set_api_creds(cc.create_or_derive_api_creds())
        # TODO: 轮动市场/事件 id 从环境取 MARKET_ID；用其 tokens 的 price 得 p_up/p_down
        return 0.5, 0.5, False
    except Exception as e:
        print("  [poly] 初始化失败:", e)
        return 0.5, 0.5, False

def place_order(side, size_usdc, price):
    """真实下单(仅在DEMO=0且已配好时). demo 只打印拟下单。"""
    demo = os.getenv("DEMO","1").strip()=="1"
    if demo:
        print(f"  [demo] 拟下单 side={side} size=${size_usdc} price={price:.3f}")
        return True
    # 真实: 用 cc.create_and_post_order(OrderArgs) 以之token_id 下单
    print(f"  [real] side={side} size=${size_usdc} price={price:.3f} (待真实 token_id/下单链)")
    return True

def main():
    interval = os.getenv("K_INTERVAL", "5m")
    thresh = float(os.getenv("THRESH", "0.08"))
    demo = os.getenv("DEMO","1").strip()=="1"
    print(f"=== Polymarket BTC5 → 币安共振 机器人 ({'DEMO' if demo else 'REAL'}) ===")
    while True:
        try:
            rows = binance_klines(interval, 200)
            if not rows:
                time.sleep(20); continue
            tdir, str_ = tech_direction(rows)
            pu, pd, okp = polymarket_probabilities()
            # 共振：币安方向 + 概率倾向同向 & 概率超出 0.5 阈值
            if tdir=="UP" and pu > 0.5 + thresh:
                side="YES"; prob=pu
            elif tdir=="DOWN" and pd > 0.5 + thresh:
                side="NO"; prob=pd
            else:
                side=None; prob=max(pu,pd)
            price = prob  # 概念价格=概率
            size = float(os.getenv("SIZE_USDC", "5"))
            print(f"[{datetime.datetime.now():%H:%M:%S}] BTC间隔={interval} tech={tdir}({str_:.2f}) p_up={pu:.3f} p_dn={pd:.3f} → 共振side={'不开' if side is None else side} (prob={prob:.3f})")
            if side: place_order(side, size, price)
        except Exception as e:
            print("  err:", e)
        time.sleep(float(os.getenv("LOOP_S", "5")))

if __name__ == "__main__":
    main()
