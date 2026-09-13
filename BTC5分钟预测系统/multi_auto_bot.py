#!/usr/bin/env python3
# multi_auto_bot.py — v7: 全局在途持仓上限=1 + 每轮只开一仓 + deposit wallet 修正
import asyncio, os, json, time, datetime, urllib.request, ccxt
from polymarket import AsyncSecureClient

ROOT="/root/polymarket-btc5"
UD=os.path.join(ROOT,"users_db.json")
MIN_DEV=float(os.getenv("MIN_DEV","0.02"))
MAX_P=float(os.getenv("MAX_P","0.9"))
ENTRY_MIN_START=float(os.getenv("ENTRY_MIN_START","2.5"))
ENTRY_MAX=float(os.getenv("ENTRY_MAX","4.0"))
# 全局在途持仓上限(每个钱包最多同时持有几个未结算仓) - 默认1
MAX_POS=float(os.getenv("MAX_POS","1"))
LIMIT_PRICE=float(os.getenv("LIMIT_PRICE","0.55"))  # 限价挂单价
LIMIT_WAIT=float(os.getenv("LIMIT_WAIT","90"))     # 等待成交秒数

def derive_deposit_wallet(pk):
    """用用户私钥纯计算推导其 Polymarket deposit wallet 地址(确定性)
    资金/下单都应在 deposit wallet 上, 而非用户 EOA 地址"""
    try:
        from polymarket._internal.environment import PRODUCTION_CONFIG
        from polymarket._internal.wallet import derive_beacon_deposit_wallet_address
        from eth_account import Account
        signer=Account.from_key(pk).address
        cfg=PRODUCTION_CONFIG.wallet_derivation
        return derive_beacon_deposit_wallet_address(signer, cfg)
    except Exception:
        return None

def load_ud():
    try:
        d=json.load(open(UD)); d.setdefault("users",{}); d.setdefault("global",{})
        return d
    except: return {"users":{},"global":{}}
def save_ud(d): json.dump(d,open(UD,"w"),indent=1)
def gl(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
    except: return None

def open_position_count(wallet):
    """查 Polymarket 真实在途持仓数(currentPrice>0), 作为全局持仓上限依据
    已结算归零(cur=0)的历史残留仓位不计入, 避免占满上限阻塞开新仓"""
    try:
        d=gl(f"https://data-api.polymarket.com/positions?user={wallet}&limit=100")
        if not isinstance(d,list): return 0
        cnt=0
        for p in d:
            cur=p.get("currentPrice")
            try: curf=float(cur) if cur is not None else 0
            except: curf=0
            title=p.get("title","") or ""
            size=p.get("size")
            if curf>0 and size and "Bitcoin Up or Down" in title and float(size)>0:
                cnt+=1
        return cnt
    except Exception:
        return 0

def current_market():
    now=int(time.time()); ts=(now//300)*300
    for dt in (0,-300):
        t=ts+dt
        r=gl(f"https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{t}")
        if isinstance(r,list) and r:
            m=(r[0].get("markets") or [{}])[0]
            toks=m.get("clobTokenIds"); toks=json.loads(toks) if isinstance(toks,str) else toks
            if m.get("acceptingOrders") and toks:
                return {"slug":f"btc-updown-5m-{t}","toks":toks,
                        "ask":float(m.get("bestAsk") or 0.5),"bid":float(m.get("bestBid") or 0.5)}
    return None

def book(tok):
    try:
        u=f"https://clob.polymarket.com/book?token_id={tok}"
        b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
        asks=b.get("asks",[]) or []
        def p(x): return float(x.get("price") or 0)
        bst_ask=min([p(a) for a in asks]) if asks else None
        return bst_ask
    except Exception:
        return None

def round_deviation():
    """当前轮BTC偏离%: 起点=本轮开始时刻的价格(整点K线的开盘)"""
    try:
        ex=ccxt.binance({"enableRateLimit":True})
        now=int(time.time()); ts=(now//300)*300
        # 拉本轮开始的1m K线(起点=ts那个整点的K线)
        rows=ex.fetch_ohlcv("BTC/USDT","1m",since=ts*1000,limit=10)
        if not rows: return None,0,None
        # rows[0] 是本轮开始的第1根K线, 用其开盘价作本轮起点
        o=rows[0][1]; latest=rows[-1][4]
        dev=(latest-o)/o*100
        return o, dev, latest
    except Exception:
        return None,0,None

async def place_order(pk, wallet, token, side, usd, slug, dev, bst_ask):
    """市价单买入(可吃贵边), 失败重试"""
    client=None
    try:
        client=await AsyncSecureClient.create(private_key=pk, wallet=wallet)
        for attempt in range(3):
            try:
                resp=await client.place_market_order(token_id=token, side="BUY", amount=str(usd))
                ok=getattr(resp,"ok",False); oid=getattr(resp,"order_id",None)
                if ok: return ok, oid
                await asyncio.sleep(2)
            except Exception as e:
                msg=repr(e)
                if "InsufficientLiquidity" in msg or "resting" in msg or "no orders found" in msg:
                    await asyncio.sleep(2); continue
                return False, msg[:120]
        return False, "market_failed"
    except Exception as e:
        return False, repr(e)[:120]
    finally:
        if client:
            try: await client.close()
            except: pass

async def run_user(addr, u, market, dev, price, now):
    pk=(u.get("pk") or "").strip()
    if not pk or len(pk)<10 or not u.get("enabled",True): return
    wallet=derive_deposit_wallet(pk) or (u.get("addr") or "").strip()
    if not wallet: return
    deposit=float(u.get("deposit",0) or 0)
    if deposit<=0: return
    size=float(u.get("size_usdc",1) or 1)
    opened=set(u.get("opened_slots",[]) or [])
    slug=market["slug"]
    if slug in opened: return  # 每轮只开一仓
    # 全局在途持仓上限: 已在途仓位 >= MAX_POS 则不再开新仓
    if open_position_count(wallet) >= MAX_POS:
        print(f"  [{addr[:8]}] 在途持仓已达上限({int(MAX_POS)}), 跳过", flush=True)
        return
    ts=int(slug.split("-")[-1]); elapsed=(now-ts)/60.0
    # 三分钟窗口 + dev 阈值
    if not (ENTRY_MIN_START < elapsed < ENTRY_MAX and abs(dev)>=MIN_DEV): return
    side = "UP" if dev>0 else "DOWN"
    token = market["toks"][0] if side=="UP" else market["toks"][1]
    bst_ask = book(token)
    if bst_ask is not None and bst_ask>MAX_P:
        print(f"  [{addr[:8]}] {side} ask={bst_ask} 太贵(>{MAX_P}), 跳过", flush=True)
        return
    ok, oid = await place_order(pk, wallet, token, side, size, slug, dev, bst_ask)
    print(f"  [{addr[:8]}] 下单 {side} ${size} dev={dev:.3f}% ask={bst_ask:.2f} ok={ok} id={str(oid)[:20]}", flush=True)
    if not ok: return
    d=load_ud(); usr=d["users"].get(addr,{})
    usr.setdefault("trades",[]).append({"t":datetime.datetime.now().strftime("%m-%d %H:%M"),
        "slug":slug,"side":side,"usd":size,"tech":round(abs(dev),2),"price":round(price or 0,2),
        "type":"early","order_id":str(oid)[:20]})
    usr.setdefault("opened_slots",[]).append(slug)
    usr["last_open"]={"slug":slug,"side":side,"usd":size,"ts":ts,"time":datetime.datetime.now().strftime("%H:%M:%S")}
    save_ud(d)

async def main():
    print(f"🚀 multi_auto_bot v7 start MIN_DEV={MIN_DEV} ENTRY={ENTRY_MIN_START}-{ENTRY_MAX}min MAX_POS={int(MAX_POS)} deposit=derive", flush=True)
    while True:
        try:
            market=current_market()
            o, dev, price = round_deviation()
            now=int(time.time())
            d=load_ud()
            users=[(a,u) for a,u in d.get("users",{}).items() if u.get("pk") and u.get("enabled",True)]
            if market and dev is not None and users:
                ts=int(market["slug"].split("-")[-1]); el=(now-ts)/60.0
                print(f"[{datetime.datetime.now():%H:%M:%S}] 轮{market['slug'][-13:]} {el:.1f}m dev={dev:+.3f}% 用户数={len(users)}", flush=True)
                for a,u in users:
                    await run_user(a, u, market, dev, price, now)
        except Exception as e:
            print("err:", repr(e)[:150], flush=True)
        await asyncio.sleep(5)

asyncio.run(main())
