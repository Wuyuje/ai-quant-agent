#!/usr/bin/env python3
# auto_bot.py v3 — 轮中动量策略: 第3分钟按BTC动量方向, 以0.5便宜价买入, 持有到结算
# 数据源: 币安BTC 1m(每轮第3分钟偏离) + Polymarket 份额(as0.50)
import asyncio, os, json, time, datetime, urllib.request, ccxt
from polymarket import AsyncSecureClient
PK=os.environ["POLY_PK"]; WALLET=os.environ["POLY_WALLET"]
USD=float(os.getenv("USD","1")); LOOP=float(os.getenv("LOOP","10"))
ENTRY_MIN=float(os.getenv("ENTRY_MIN","3"))    # 第几分钟判断(1-4)
MIN_DEV=float(os.getenv("MIN_DEV","0.05"))     # 最小偏离%(0.05=0.05%)
MAX_P=float(os.getenv("MAX_P","0.50"))         # 份额价上限(买贵不做)
ROOT="/root/polymarket-btc5"; STATE=ROOT+"/bot_state.json"

def load_state():
    try: return json.load(open(STATE))
    except: return {"trades":[],"open":{}}
def save_state(s): json.dump(s,open(STATE,"w"),indent=1)
def enabled():
    try: return bool(json.load(open(ROOT+"/runner.json")).get("enabled",False))
    except: return False
def gl(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
    except: return None

def current_market():
    """获取当前轮(接受订单)的市场, 返回 (slug, toks, ask)"""
    now=int(time.time()); ts=(now//300)*300
    for dt in (0,-300):
        t=ts+dt
        r=gl(f"https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{t}")
        if isinstance(r,list) and r:
            m=(r[0].get("markets") or [{}])[0]
            toks=m.get("clobTokenIds"); toks=json.loads(toks) if isinstance(toks,str) else toks
            if m.get("acceptingOrders") and toks:
                return (f"btc-updown-5m-{t}", toks, float(m.get("bestAsk") or 0.5), m)
    return None

def round_deviation():
    """当前轮 BTC 累计偏离% (从轮起点到现在的第N分钟)"""
    try:
        ex=ccxt.binance({"enableRateLimit":True})
        now=int(time.time()); ts=(now//300)*300
        # 拉该轮内的1mK线 (轮起点到当前)
        since=(ts-300)*1000
        rows=ex.fetch_ohlcv("BTC/USDT","1m",since=since,limit=10)
        if not rows: return None,0,None
        o=rows[0][1]  # 轮起点开盘价
        latest=rows[-1][4]
        elapsed=(now-ts)/60.0  # 轮内已过分钟
        dev=(latest-o)/o*100
        # 判断用的分钟数 = 当前已过分钟 (约3分钟判断)
        return o, dev, latest
    except Exception as e:
        return None,0,None

async def main():
    print(f"🎯 bot v3 start MODE=round-momentum ENTRY_MIN={ENTRY_MIN} MIN_DEV={MIN_DEV} MAX_P={MAX_P}", flush=True)
    last_signal_round=None
    while True:
        try:
            live=current_market()
            o, dev, price = round_deviation()
            enabled_flag=enabled()
            # 判断时点: 轮内已过约 ENTRY_MIN 分钟 (避免轮初无数据/轮末买贵)
            now=int(time.time()); ts=(now//300)*300; elapsed=(now-ts)/60.0
            tdir=None; strength=0
            # 入场窗口: 第3分钟附近(2.5-4.0分), 且偏离达标即触发(更早入场, 趁份额价便宜)
            if live and o and 2.5<elapsed<4.0 and abs(dev)>=MIN_DEV:
                tdir = "UP" if dev>0 else "DOWN"
                strength=abs(dev)
            if live and o:
                print(f"[{datetime.datetime.now():%H:%M:%S}] 轮内{elapsed:.1f}分 dev={dev:+.3f}% ask={live[2]:.2f} enabled={enabled_flag} signal={tdir}", flush=True)
            if live and tdir and enabled_flag:
                slug,toks,ask,m=live
                st=load_state()
                if st.get("open",{}).get("slug")!=slug:
                    # 份额价过滤: 只能买便宜的(≤MAX_P), 轮中ask≈0.5
                    p=ask if tdir=="UP" else (1-ask)
                    if p>MAX_P:
                        print(f"  份额价p={p:.3f} > {MAX_P} 跳过(太贵)", flush=True)
                        continue
                    token=toks[0] if tdir=="UP" else toks[1]
                    client=await AsyncSecureClient.create(private_key=PK, wallet=WALLET)
                    try:
                        resp=await client.place_market_order(token_id=token, side="BUY", amount=str(USD))
                        ok=getattr(resp,"ok",False)
                        print(f"  下单 {tdir} ${USD} dev={dev:.3f}% p={p:.3f} ok={ok} id={getattr(resp,'order_id',None)}", flush=True)
                        if ok:
                            try: await client.wait_for_order_fill_settlement(resp)
                            except Exception: pass
                            st=load_state()
                            st.setdefault("trades",[]).append({"t":datetime.datetime.now().strftime("%m-%d %H:%M"),"slug":slug,"side":tdir,"usd":USD,"tech":round(abs(dev),2),"price":round(price or 0,2),"type":"momentum"})
                            st["open"]={"slug":slug,"side":tdir}; save_state(st)
                    finally:
                        try: await client.close()
                        except Exception: pass
        except Exception as e:
            print("err:", repr(e)[:200], flush=True)
        await asyncio.sleep(5)
asyncio.run(main())
