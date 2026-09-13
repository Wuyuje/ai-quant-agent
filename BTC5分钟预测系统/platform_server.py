#!/usr/bin/env python3
# platform_server.py — 多用户平台 (完整重建, 含全部接口)
import http.server, socketserver, json, os, time, threading, urllib.request
from urllib.parse import urlparse, parse_qs
ROOT="/root/polymarket-btc5"; UD=os.path.join(ROOT,"users_db.json")
ADMIN=os.getenv("ADMIN","0x9999c0fc24d4468afa840fc5c1b5f01775b5ee79").lower().strip()
DEPOSIT_WALLET="0xe1688a2094690a69dc103832f8edc1e8daf1171d"

def rd(p,d=None):
    try: return json.load(open(os.path.join(ROOT,p)))
    except: return d
def wr(p,o): json.dump(o,open(os.path.join(ROOT,p),"w"))
def load_ud():
    if os.path.exists(UD):
        try:
            d=json.load(open(UD))
            d.setdefault("users",{}); d.setdefault("global",{"auto_enabled":True,"threshold":0.02,"size_usdc":1,"mode":"twap"})
            d["users"].pop(DEPOSIT_WALLET, None)
            return d
        except: pass
    return {"users":{}, "global":{"auto_enabled":True,"threshold":0.02,"size_usdc":1,"mode":"twap"}}
def save_ud(d): json.dump(d,open(UD,"w"),indent=1)
lock=threading.Lock()
def page(f):
    p=os.path.join(ROOT,f)
    return open(p).read() if os.path.exists(p) else "<h3>%s</h3>"%f
_KLINE_CACHE={}
_GLOB={}
def klines(interval="5m",limit=200):
    """K线(带15秒缓存, 消除后端实时拉币安的卡顿)
    5m K线每5分钟才出一根, 15秒缓存完全无感知但弹性能100倍"""
    global _KLINE_CACHE
    key=f"{interval}|{limit}"
    now=time.time()
    c=_KLINE_CACHE.get(key)
    if c and now-c["t"]<60:
        return c["data"]
    try:
        import ccxt
        ex=ccxt.binance({"enableRateLimit":True}); rows=ex.fetch_ohlcv("BTC/USDT",interval,limit=limit)
        data=[[r[0],r[1],r[2],r[3],r[4],r[5]] for r in rows]
        _KLINE_CACHE[key]={"t":now,"data":data}
        return data
    except Exception as e:
        return {"err":str(e)[:120]}
def _poly_data(addr):
    """读 Polymarket 真实持仓/盈亏 (公开 data-api)"""
    try:
        u=f"https://data-api.polymarket.com/positions?user={addr.lower()}"
        d=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
        pos=[p for p in d if isinstance(p,dict)]
        total_pnl=sum(float(p.get("cashPnl") or 0) for p in pos)
        total_value=sum(float(p.get("value") or 0) for p in pos)
        open_pos=[p for p in pos if (p.get("size") or 0)>0]
        # 持仓明细: 含实时浮动盈亏(当前价-成本)
        samples=[]
        for p in pos[:12]:
            size=float(p.get("size") or 0); avg=float(p.get("avgPrice") or 0)
            cur=float(p.get("currentPrice") or avg)
            cost=avg*size; val=cur*size
            samples.append({"title":(p.get("title") or "")[:36],"size":round(size,3),
                            "avg":avg,"cur":round(cur,4),
                            "cost":round(cost,3),"value":round(val,3),
                            "floatPnl":round(val-cost,4),"pnl":round(float(p.get("cashPnl") or 0),4)})
        return {"positions": len(pos), "open": len(open_pos),
                "totalPnl": round(total_pnl,4), "totalValue": round(total_value,4),
                "floatPnl": round(sum(s["floatPnl"] for s in samples),4),
                "samples": samples}
    except Exception as e:
        return {"error": repr(e)[:120]}


POLY_LOCK=threading.Lock()
def _poly_cached():
    """读缓存(毫秒级), 陈旧则后台单实例刷新"""
    cache_path=os.path.join(ROOT,"poly_cache.json")
    try:
        c=json.load(open(cache_path))
        if time.time()-c.get("t",0)<15:
            return {k:v for k,v in c.items() if k!="t"}
    except Exception: pass
    try:
        c=json.load(open(cache_path))
        res={k:v for k,v in c.items() if k!="t"}
    except Exception:
        res={"addr":DEPOSIT_WALLET,"poly":{"positions":0,"open":0,"totalPnl":0,"totalValue":0,"floatPnl":0,"samples":[]}}
    if POLY_LOCK.acquire(blocking=False):
        threading.Thread(target=_refresh_poly_cache,daemon=True).start()
    return res

def _refresh_poly_cache():
    try:
        r={"addr":DEPOSIT_WALLET,"poly":_poly_data(DEPOSIT_WALLET)}; r["t"]=time.time()
        json.dump(r,open(os.path.join(ROOT,"poly_cache.json"),"w"))
    finally:
        if POLY_LOCK.locked():
            POLY_LOCK.release()


def _compute_mom_pnl():
    """实际计算新策略盈亏(慢, 后台调用)"""
    import ccxt
    d=rd("bot_state.json",{"trades":[]})
    trades=[t for t in d.get("trades",[]) if t.get("type")=="momentum"]
    ex=ccxt.binance({"enableRateLimit":True})
    now=int(time.time())
    wins=0; loss=0; pending=0; pnl=0.0; vol=0.0
    for t in trades:
        ts=int(t["slug"].split("-")[-1]); usd=t.get("usd",1); side=t["side"]
        if ts+300>now: pending+=1; continue
        try:
            rows=ex.fetch_ohlcv("BTC/USDT","1m",since=(ts-300)*1000,limit=10)
            o=rows[0][1]; close=rows[-1][4]
            win=(close<o) if side=="DOWN" else (close>o)
            if win: wins+=1; pnl+=usd*0.45
            else: loss+=1; pnl-=usd
            vol+=usd
        except Exception:
            pending+=1
    return {"settled":wins+loss,"wins":wins,"loss":loss,"pending":pending,
            "winrate":round(wins/(wins+loss)*100,1) if wins+loss else 0,
            "invested":round(vol,2),"pnl":round(pnl,2),"roi":round(pnl/vol*100,1) if vol else 0}

def _mom_pnl():
    """读缓存(毫秒级), 缓存陈旧则后台刷新"""
    cache_path=os.path.join(ROOT,"mom_cache.json")
    try:
        c=json.load(open(cache_path))
        if time.time()-c.get("t",0)<120:
            return {k:v for k,v in c.items() if k!="t"}
    except Exception: pass
    # 缓存陈旧/不存在 -> 返回旧的或空, 并触发后台线程刷新
    try:
        c=json.load(open(cache_path))
        res={k:v for k,v in c.items() if k!="t"}
        threading.Thread(target=_refresh_mom_cache,daemon=True).start()
        return res
    except Exception:
        threading.Thread(target=_refresh_mom_cache,daemon=True).start()
        return {"settled":0,"wins":0,"loss":0,"pending":0,"winrate":0,"invested":0,"pnl":0,"roi":0}

def _refresh_mom_cache():
    try:
        r=_compute_mom_pnl(); r["t"]=time.time()
        json.dump(r,open(os.path.join(ROOT,"mom_cache.json"),"w"))
    except Exception: pass


def _compute_real_balance():
    """实际读 Polymarket 真实余额(慢, 后台调用)"""
    import asyncio
    from polymarket import AsyncSecureClient
    PK=os.getenv("POLY_PK","0xd881c3d2589921dde4fa35e73cad8cd28389fd13b8deae2b7b7ead48bd3723f5")
    W=os.getenv("POLY_WALLET","0xe1688A2094690a69DC103832f8edc1E8Daf1171d")
    async def _run():
        c=await AsyncSecureClient.create(private_key=PK, wallet=W)
        bal=None; val=None
        try:
            b=await c.get_balance_allowance(asset_type="COLLATERAL")
            bal=float(getattr(b,"balance",0))/1e6
        except Exception: pass
        try:
            pv=await c.get_portfolio_values()
            val=float(pv[0].value) if pv else 0
        except Exception: pass
        await c.close()
        return {"collateral":round(bal,4) if bal is not None else None,
                "portfolioValue":round(val,4),
                "netWorth":round((bal or 0)+(val or 0),4)}
    return asyncio.run(_run())

def _real_balance():
    """读缓存(毫秒级), 30s刷新"""
    cache_path=os.path.join(ROOT,"rb_cache.json")
    try:
        c=json.load(open(cache_path))
        if time.time()-c.get("t",0)<30:
            return {k:v for k,v in c.items() if k!="t"}
    except Exception: pass
    try:
        c=json.load(open(cache_path))
        res={k:v for k,v in c.items() if k!="t"}
    except Exception:
        res=None
    threading.Thread(target=_refresh_rb_cache,daemon=True).start()
    return res or {"collateral":None,"portfolioValue":None,"netWorth":None,"loading":True}

def _refresh_rb_cache():
    try:
        r=_compute_real_balance(); r["t"]=time.time()
        json.dump(r,open(os.path.join(ROOT,"rb_cache.json"),"w"))
    except Exception: pass

# ===== 按用户地址查 Polymarket 实盘资金 (用该用户自己的私钥签名查询) =====

def derive_deposit_wallet(pk):
    """用用户私钥纯计算推导其 Polymarket deposit wallet 地址(确定性, 无需部署/无需建连)
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

def _compute_user_real_balance(addr, pk):
    """用指定用户的私钥, 推导其 Polymarket deposit wallet 并查真实余额(慢, 后台调用)
    资金在 deposit wallet 上, 不是用户 EOA 地址"""
    import asyncio
    from polymarket import AsyncSecureClient
    addr=addr.lower(); pk=pk.strip()
    # 推导 deposit wallet
    dw=derive_deposit_wallet(pk) or addr
    async def _run():
        c=None
        try:
            c=await AsyncSecureClient.create(private_key=pk, wallet=dw)
            bal=None; val=None
            try:
                b=await c.get_balance_allowance(asset_type="COLLATERAL")
                bal=float(getattr(b,"balance",0))/1e6
            except Exception: pass
            try:
                pv=await c.get_portfolio_values()
                val=float(pv[0].value) if pv else 0
            except Exception: pass
            pos=_poly_data(dw)
            if isinstance(pos,dict) and pos.get("error"): pos=None
            return {"addr":addr,"depositWallet":dw,"hasKey":True,
                    "collateral":round(bal,4) if bal is not None else None,
                    "portfolioValue":round(val,4),
                    "netWorth":round((bal or 0)+(val or 0),4),
                    "positions": pos.get("open",0) if pos else 0,
                    "openPositions": (pos.get("samples",[]) if pos else [])[:6]}
        except Exception as e:
            return {"addr":addr,"hasKey":True,"error":repr(e)[:120]}
        finally:
            if c:
                try: await c.close()
                except Exception: pass
    return asyncio.run(_run())


def _manual_order(action, side, usd):
    """管理员手动交易: 用管理员deposit wallet真实下单
    action: buy/sell; side: UP/DOWN; usd: 买入金额"""
    import asyncio
    from polymarket import AsyncSecureClient
    pk=(os.getenv("POLY_PK","") or "").strip()
    dw=DEPOSIT_WALLET
    d=load_ud(); u=d["users"].get(ADMIN,{}) or {}
    if not pk: pk=(u.get("pk") or "").strip()
    if not pk: return {"ok":False,"err":"no admin pk"}
    now=int(time.time()); ts=(now//300)*300
    market=None
    def _http(u):
        try:
            return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
        except: return None
    for dt in (0,-300):
        t=ts+dt
        r=_http(f"https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{t}")
        if isinstance(r,list) and r:
            m=(r[0].get("markets") or [{}])[0]
            toks=m.get("clobTokenIds"); toks=json.loads(toks) if isinstance(toks,str) else toks
            if m.get("acceptingOrders") and toks:
                market={"slug":f"btc-updown-5m-{t}","toks":toks}
                break
    if not market: return {"ok":False,"err":"no active market"}
    up_token=str(market["toks"][0]); down_token=str(market["toks"][1])
    async def _run():
        c=await AsyncSecureClient.create(private_key=pk, wallet=dw)
        try:
            if action=="sell":
                # 卖出: 找当前轮所有持仓(UP或DOWN), 全部卖出
                pag=c.list_positions()
                sold=[]; errs=[]
                async for pg in pag:
                    for pos in pg.items:
                        try:
                            aid=str(getattr(pos,"asset_id","") or "")
                            sz=float(getattr(pos,"size",0) or 0)
                            if sz>0 and aid in (up_token, down_token):
                                which="UP" if aid==up_token else "DOWN"
                                try:
                                    resp=await c.place_market_order(token_id=aid, side="SELL", shares=str(sz), max_price="0.99")
                                    ok=getattr(resp,"ok",False); oid=getattr(resp,"order_id",None)
                                    if ok: sold.append({"side":which,"shares":round(sz,4),"order_id":str(oid)[:20]})
                                    else: errs.append(f"{which}:rejected")
                                except Exception as e:
                                    errs.append(f"{which}:{repr(e)[:50]}")
                        except: pass
                if sold:
                    return {"ok":True,"action":"sell","sold":sold,"errs":errs,"slug":market["slug"]}
                return {"ok":False,"err":"no position to sell","errs":errs}
            else:
                token = str(market["toks"][0]) if side=="UP" else str(market["toks"][1])
                resp=await c.place_market_order(token_id=token, side="BUY", amount=str(usd))
                ok=getattr(resp,"ok",False); oid=getattr(resp,"order_id",None)
                return {"ok":ok,"order_id":str(oid)[:24] if oid else None,"action":action,"side":side,"usd":usd,"slug":market["slug"]}
        finally:
            try: await c.close()
            except: pass
    return asyncio.run(_run())

_URB_LOCK=threading.Lock()
def _user_real_balance(addr):
    """返回用户在 Polymarket 的真实实盘资金。
    管理员(ADMIN) → 显示管理员 Deposit Wallet(0xe1688) 的实盘；
    普通用户 → 显示该用户自己地址在 Polymarket 的真实实盘，绝不混淆。"""
    addr=addr.lower()
    # 管理员账户 → 显示管理员 Deposit Wallet 实盘
    if addr==ADMIN:
        return _real_balance()
    # 普通用户 → 该用户自己地址的实盘
    d=load_ud(); u=d["users"].get(addr) or {}
    pk=(u.get("pk") or "").strip()
    if not pk or len(pk)<64:
        # 无私钥: 用公开 data-api 只读该地址持仓
        pos=_poly_data(addr)
        return {"addr":addr,"hasKey":False,"collateral":None,"portfolioValue":None,
                "netWorth":None,
                "positions": (pos.get("open",0) if isinstance(pos,dict) else 0),
                "openPositions": (pos.get("samples",[]) if isinstance(pos,dict) else [])[:6],
                "note":"该地址在 Polymarket 无独立资金(或未绑定私钥)"}
    cache_path=os.path.join(ROOT, f"rb_user_{addr[2:10]}.json")
    try:
        c=json.load(open(cache_path))
        if time.time()-c.get("t",0)<30:
            return {k:v for k,v in c.items() if k!="t"}
    except Exception: pass
    try:
        c=json.load(open(cache_path)); res={k:v for k,v in c.items() if k!="t"}
    except Exception:
        res={"addr":addr,"hasKey":True,"loading":True}
    if _URB_LOCK.acquire(blocking=False):
        threading.Thread(target=_refresh_user_rb,args=(addr,pk),daemon=True).start()
    return res or {"addr":addr,"hasKey":True,"loading":True}

def _refresh_user_rb(addr, pk):
    try:
        r=_compute_user_real_balance(addr, pk); r["t"]=time.time()
        json.dump(r,open(os.path.join(ROOT, f"rb_user_{addr[2:10]}.json"),"w"))
    except Exception: pass
    finally:
        if _URB_LOCK.locked(): _URB_LOCK.release()


def _compute_current_position():
    """当前在途持仓: 只显示"当前轮"的真实持仓(用Polymarket客户端取准确avg/size/cur)"""
    try:
        import ccxt, asyncio
        from polymarket import AsyncSecureClient
        now=int(time.time()); cur_ts=(now//300)*300
        cur_slug=f"btc-updown-5m-{cur_ts}"
        pk=(os.getenv("POLY_PK","") or "").strip()
        dw=DEPOSIT_WALLET
        d0=load_ud(); a0=d0["users"].get(ADMIN,{}) or {}
        if not pk: pk=(a0.get("pk") or "").strip()
        pos=None
        if pk:
            async def _get():
                c=await AsyncSecureClient.create(private_key=pk, wallet=dw)
                try:
                    pag=c.list_positions(); out=[]
                    async for pg in pag:
                        for p in pg.items:
                            try:
                                sz=float(p.size or 0); cp=float(p.cur_price or 0)
                                if sz>0 and str(p.slug)==cur_slug:
                                    out.append({"slug":p.slug,"side":(p.outcome or "UP").upper(),
                                                "size":sz,"avg":float(p.avg_price or 0),"cur":cp,
                                                "title":(p.title or "")[:40]})
                            except: pass
                    return out
                finally:
                    try: await c.close()
                    except: pass
            try: lst=asyncio.run(_get())
            except Exception: lst=[]
            if lst:
                p0=lst[0]
                # 用币安dev估算实时价(更灵敏)
                ex=ccxt.binance({"enableRateLimit":True})
                est_p=None; dev=None; o=None; cur=None
                try:
                    rows=ex.fetch_ohlcv("BTC/USDT","1m",since=cur_ts*1000,limit=10)
                    if rows:
                        o=rows[0][1]; cur=rows[-1][4]; dev=(cur-o)/o*100
                        lead=dev if p0["side"]=="UP" else -dev
                        est_p=max(0.02,min(0.98,0.5+max(-0.48,min(0.48,lead*3))))
                except: pass
                use_p = est_p if est_p is not None else p0["cur"]
                cost=p0["avg"]*p0["size"]; val=use_p*p0["size"]
                pos={"slug":cur_slug,"ts":cur_ts,"side":p0["side"],"title":p0["title"],
                     "usd":round(cost,2),"size":round(p0["size"],3),"avg":round(p0["avg"],4),
                     "curP":round(use_p,4),"floatPnlUsd":round(val-cost,4),
                     "dev":round(dev,3) if dev is not None else None,
                     "start":round(o,2) if o else None,"now":round(cur,2) if cur else None,
                     "remain":max(0,(cur_ts+300)-now)}
        return {"hasPosition":bool(pos),"position":pos,"nowTs":cur_ts}
    except Exception as e:
        return {"error":repr(e)[:100]}

POS_LOCK=threading.Lock()
def _current_position():
    """读缓存(毫秒级), 缓存陈旧则后台单实例刷新"""
    cache_path=os.path.join(ROOT,"pos_cache.json")
    try:
        c=json.load(open(cache_path))
        if time.time()-c.get("t",0)<3:
            return {k:v for k,v in c.items() if k!="t"}
    except Exception: pass
    try:
        c=json.load(open(cache_path))
        res={k:v for k,v in c.items() if k!="t"}
    except Exception:
        res={"hasPosition":False,"position":None,"nowTs":(int(time.time())//300)*300}
    # 仅当没有刷新线程在跑时才启动新的, 防止线程堆叠
    if POS_LOCK.acquire(blocking=False):
        threading.Thread(target=_refresh_pos_cache,daemon=True).start()
    return res

def _refresh_pos_cache():
    try:
        r=_compute_current_position(); r["t"]=time.time()
        json.dump(r,open(os.path.join(ROOT,"pos_cache.json"),"w"))
    finally:
        if POS_LOCK.locked():
            POS_LOCK.release()


# 真实 Polymarket 交易缓存
_RT_LOCK=threading.Lock()
def _real_poly_trades(dw, limit=30):
    """从 Polymarket data-api 拉取 deposit wallet 的真实交易记录(带缓存)
    返回格式化的交易列表: [{t,side,usd,tech,price,slug}, ...]"""
    cache_path=os.path.join(ROOT, f"rt_{dw[2:10]}.json")
    try:
        c=json.load(open(cache_path))
        if time.time()-c.get("t",0)<60:  # 60秒缓存
            return c.get("trades",[])
    except Exception: pass
    try:
        u=f"https://data-api.polymarket.com/trades?user={dw}&limit={limit}&sortBy=createTime&sortDirection=desc"
        d=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
        trades=[]
        for t in (d if isinstance(d,list) else []):
            try:
                slug=t.get("slug","") or ""
                ts=None
                if "-" in slug:
                    try: ts=int(slug.split("-")[-1])
                    except: ts=None
                tstr=""
                if ts:
                    tstr=time.strftime("%m-%d %H:%M",time.localtime(ts))
                side="UP" if (t.get("outcome") or "").lower()=="up" else "DOWN"
                trades.append({"t":tstr,"side":side,
                               "usd":round(float(t.get("size") or 0)*float(t.get("price") or 0),2),
                               "tech":round(float(t.get("price") or 0),2),"price":round(float(t.get("price") or 0),4),
                               "slug":slug,"real":True})
            except Exception: continue
        r={"t":time.time(),"trades":trades}
        try: json.dump(r,open(cache_path,"w"))
        except: pass
        return trades
    except Exception:
        return []


def _trade_records(limit=50):
    """管理员交易记录: 真实交易 + 结算结果 + 盈亏"""
    trades=_real_poly_trades(DEPOSIT_WALLET, limit)
    out=[]
    for t in trades:
        slug=t.get("slug","")
        side=t.get("side","UP")
        price=float(t.get("price") or 0)
        usd=float(t.get("usd") or 0)
        # 查该轮结算结果
        winner=None
        try:
            r=_http_get(f"https://gamma-api.polymarket.com/events?slug={slug}")
            if isinstance(r,list) and r:
                m=(r[0].get("markets") or [{}])[0]
                op=m.get("outcomePrices")
                import ast
                if isinstance(op,str):
                    try: op=ast.literal_eval(op)
                    except: op=None
                if isinstance(op,list) and len(op)==2:
                    up=float(op[0])
                    if up>=0.9: winner="UP"
                    elif up<=0.1: winner="DOWN"
        except: pass
        # 盈亏: 若该边赢 -> 赚(1-price)*份数; 输 -> 亏 price*份数
        shares=round(usd/price,2) if price>0 else 0
        pnl=None; result="结算中"
        if winner:
            if side==winner: pnl=round((1-price)*shares,3); result="WIN"
            else: pnl=round(-price*shares,3); result="LOSS"
        out.append({"t":t.get("t"),"side":side,"usd":usd,"price":round(price,3),
                    "slug":slug,"result":result,"pnl":pnl})
    # 汇总
    settled=[o for o in out if o["pnl"] is not None]
    wins=sum(1 for o in settled if o["result"]=="WIN")
    total_pnl=round(sum(o["pnl"] for o in settled),2)
    return {"trades":out,"settled":len(settled),"wins":wins,
            "winrate":round(wins/len(settled)*100,1) if settled else 0,
            "totalPnl":total_pnl}

def _http_get(u):
    try:
        return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
    except: return None

def _user_real_trades(addr, ud=None):
    """返回某用户在 Polymarket 的真实交易(通过其 deposit wallet)"""
    try:
        if ud is None: ud=load_ud()
        u=ud.get("users",{}).get(addr.lower(),{}) or {}
        pk=(u.get("pk") or "").strip()
        if not pk or len(pk)<64: return []
        dw=derive_deposit_wallet(pk) or addr.lower()
        return _real_poly_trades(dw, 30)
    except Exception:
        return []

def _user_trades(addr, ud=None, for_admin=False):
    """按充值占比轮流分配全局交易到各用户
    归属: 有充值的用户按充值额占比作为权重, 把全局交易按时间顺序轮流分配
    for_admin=True 时返回 {addr: [trades...]} 全部分配结果
    """
    try:
        if ud is None: ud=load_ud()
        users=ud.get("users",{}) or {}
        pool=[(k,u.get("deposit",0) or 0) for k,u in users.items() if (u.get("deposit",0) or 0)>0]
        if not pool: return {} if for_admin else []
        tot=sum(w for _,w in pool)
        # 权重归一化
        weights=[w/tot for _,w in pool]
        all_t=rd("bot_state.json",{"trades":[]}).get("trades",[]) or []
        all_t=[t for t in all_t if t.get("type")=="momentum"]
        if not all_t: return {} if for_admin else []
        # 时间升序
        all_t=sorted(all_t,key=lambda x:x.get("slug","") or "")
        n=len(all_t)
        # 每个用户的期望分配笔数 = 权重*n, 用最大余数法保证总和=n
        raw=[w*n for w in weights]
        alloc=[int(r) for r in raw]
        rem=[r-int(r) for r in raw]
        deficit=n-sum(alloc)
        order=sorted(range(len(pool)),key=lambda i:-rem[i])
        for i in range(deficit): alloc[order[i%len(order)]]+=1
        # 按累计分配切分交易序列
        result={k:[] for k,_ in pool}
        pos=0
        for i,(k,_) in enumerate(pool):
            cnt=alloc[i]
            result[k]=[dict(t) for t in all_t[pos:pos+cnt]]
            pos+=cnt
        if for_admin: return result
        # 单用户: 返回该用户的交易(时间倒序, 最新在前)
        tr=result.get(addr,[])
        return sorted(tr,key=lambda x:x.get("slug","") or "",reverse=True)
    except Exception:
        return {} if for_admin else []

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _j(self,c,o):
        b=json.dumps(o,ensure_ascii=False).encode(); self.send_response(c)
        self.send_header("Content-Type","application/json;charset=utf-8"); self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def _h(self,s):
        b=s.encode(); self.send_response(200); self.send_header("Content-Type","text/html;charset=utf-8")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u=urlparse(self.path); q=parse_qs(u.query); p=u.path
        if p=="/": return self._h(page("user.html"))
        if p=="/admin": return self._h(page("admin_v2.html"))
        if p=="/chart": return self._h(page("chart.html"))
        if p=="/api/real_balance":
            a=(q.get("addr",[""])[0]).strip().lower()
            if a:
                return self._j(200,_user_real_balance(a))
            return self._j(200,_real_balance())
        if p=="/api/current_position": return self._j(200,_current_position())
        if p=="/api/current_trades": return self._j(200,_current_trades())
        if p=="/api/trade_records": return self._j(200,_trade_records(50))
        if p=="/api/mom_pnl": return self._j(200,_mom_pnl())
        if p=="/api/state": return self._j(200,{"runner":rd("runner.json",{"enabled":False}),"bot":rd("bot_state.json",{"trades":[]}),"stats":rd("stats.json",{})})
        if p=="/api/twap": return self._j(200, rd("twap_state.json",{}))
        if p=="/api/stats": return self._j(200, rd("stats.json",{}))
        if p=="/api/klines":
            iv=q.get("interval",["5m"])[0]; lim=int(q.get("limit",["200"])[0])
            return self._j(200, klines(iv,lim))
        if p=="/api/users":
            # 5秒响应缓存, 避免每次都重算所有用户(真实交易+余额)
            _uc=_GLOB.get("users_cache")
            if _uc and time.time()-_uc[0]<5:
                return self._j(200,_uc[1])
            d=load_ud()
            for u in d["users"].values():
                addr=u.get("addr","")
                # 真实 Polymarket 交易(经 deposit wallet)
                u["trades"]=_user_real_trades(addr,d)
                # 真实权益: 有私钥用户查 Polymarket 余额(collateral+持仓), 作为 equity
                rb=_user_real_balance(addr)
                if isinstance(rb,dict) and rb.get("hasKey") and rb.get("netWorth") is not None:
                    u["real"]=rb
                    u["equity"]=rb.get("netWorth",0)
                    u["collateral"]=rb.get("collateral")
                else:
                    # 无私钥(无法查Polymarket权益): 收益视为0, equity=deposit
                    u["equity"]=u.get("deposit",0)
                    u["real"]={"hasKey":False,"note":"未绑定Polymarket钱包私钥"}
            _resp={"users":list(d["users"].values()),"global":d["global"]}
            _GLOB["users_cache"]=[time.time(),_resp]
            return self._j(200,_resp)
        if p=="/api/me":
            a=(q.get("addr",[""])[0]).lower(); d=load_ud()
            u=dict(d["users"].get(a) or {})
            # 实盘交易: 该用户在 Polymarket 的真实交易(经 deposit wallet)
            u["trades"]=_user_real_trades(a,d)
            # 实盘资金: 该用户自己在 Polymarket 的真实余额(有私钥才查)
            u["real"]=_user_real_balance(a)
            return self._j(200,{"user":u,"isAdmin":a==ADMIN})
        if p=="/api/poly":
            return self._j(200,_poly_cached())
        if p=="/api/poly_data":
            a=(q.get("addr",[""])[0])
            return self._j(200,{"addr":a,"poly":_poly_data(a)})
        if p=="/api/balance":
            a=(q.get("addr",[""])[0])
            return self._j(200,{"addr":a,"usdc":None})
        if p=="/api/start": wr("runner.json",{"enabled":True}); return self._j(200,{"enabled":True})
        if p=="/api/stop": wr("runner.json",{"enabled":False}); return self._j(200,{"enabled":False})
        return self._j(404,{"err":"nf"})
    def do_POST(self):
        ln=int(self.headers.get("Content-Length","0") or 0)
        try: req=json.loads(self.rfile.read(ln).decode() or "{}")
        except: req={}
        u=urlparse(self.path).path
        with lock:
            if u=="/api/auth":
                a=(req.get("addr","")).lower()
                if len(a)!=42 or not a.startswith("0x"): return self._j(400,{"err":"bad addr"})
                d=load_ud(); d["users"].setdefault(a,{"addr":a,"authorized":False,"auto":False,"size_usdc":1,"wins":0,"loss":0,"equity":0,"deposit":0,"enabled":True,"created":int(time.time())})
                d["users"][a]["authorized"]=True; save_ud(d); return self._j(200,{"user":d["users"][a]})
            if u=="/api/config":
                a=(req.get("addr","")).lower(); d=load_ud(); usr=d["users"].get(a)
                if not usr: return self._j(404,{"err":"no user"})
                for k in ("auto","size_usdc","threshold","mode","pk","pk_on"):
                    if k in req:
                        if k=="pk" and req["pk"]:
                            # 保存私钥前验证: 私钥推导地址 == 当前用户地址
                            pkv=(req["pk"] or "").strip()
                            if len(pkv)<64: return self._j(403,{"err":"invalid private key"})
                            try:
                                from eth_account import Account
                                pkv2=pkv if pkv.startswith("0x") else "0x"+pkv
                                if Account.from_key(pkv2).address.lower()!=a:
                                    return self._j(403,{"err":"private key does not match address"})
                            except Exception:
                                return self._j(403,{"err":"bad private key"})
                            usr[k]=pkv2
                            usr["pk_on"]=True
                        elif k=="pk":
                            usr[k]=""; usr["pk_on"]=False
                        else:
                            usr[k]=req[k]
                save_ud(d); return self._j(200,{"user":usr})
            if u=="/api/deposit":
                a=(req.get("addr","")).lower(); d=load_ud(); usr=d["users"].get(a)
                if not usr: return self._j(404,{"err":"no user"})
                amt=float(req.get("amount",0) or 0); cur=(req.get("currency","USDC") or "USDC").upper()
                usr["deposit"]=float(usr.get("deposit",0))+amt
                usr["deposit_"+("usdt" if cur=="USDT" else "usdc")]=float(usr.get("deposit_"+("usdt" if cur=="USDT" else "usdc"),0))+amt
                save_ud(d); return self._j(200,{"user":usr,"currency":cur})
            if u=="/api/admin/bind":
                key=(req.get("key","") or "").strip()
                a=(req.get("addr","") or "").lower()
                if len(a)!=42 or not a.startswith("0x"): return self._j(400,{"err":"bad addr"})
                # 用钱包私钥验证: 私钥推导地址 == 输入的地址
                if not key or len(key)<64: return self._j(403,{"err":"invalid private key"})
                try:
                    from eth_account import Account
                    pk=key if key.startswith("0x") else "0x"+key
                    derived=Account.from_key(pk).address.lower()
                    if derived!=a: return self._j(403,{"err":"private key does not match address"})
                except Exception as e:
                    return self._j(403,{"err":"bad private key"})
                d=load_ud(); d["users"].setdefault(a,{"addr":a,"authorized":True,"auto":False,"size_usdc":1,"wins":0,"loss":0,"equity":0,"deposit":0,"enabled":True,"created":int(time.time())})
                d["users"][a]["authorized"]=True
                d["users"][a]["pk"]=pk  # 保存钱包私钥(用于独立开仓)
                save_ud(d)
                return self._j(200,{"ok":True,"admin":a,"isAdmin":True})
            if u=="/api/admin/set":
                if (req.get("addr","")).lower()!=ADMIN: return self._j(403,{"err":"not admin"})
                d=load_ud(); t=(req.get("target","")).lower()
                if t in d["users"]:
                    for k in ("enabled","auto","authorized"):
                        if k in req: d["users"][t][k]=bool(req[k])
                if isinstance(req.get("global"),dict): d["global"].update(req["global"])
                save_ud(d); return self._j(200,{"ok":True,"global":d["global"]})
            if u=="/api/admin/delete":
                if (req.get("addr","")).lower()!=ADMIN: return self._j(403,{"err":"not admin"})
                d=load_ud(); t=(req.get("target","")).lower()
                if t in d["users"]: del d["users"][t]; save_ud(d); return self._j(200,{"deleted":t})
                return self._j(404,{"err":"no user"})
            if u=="/api/manual_order":
                # 管理员手动交易: 买涨/买跌/卖出 (真实Polymarket下单)
                if (req.get("addr","")).lower()!=ADMIN.lower():
                    return self._j(403,{"err":"not admin"})
                action=(req.get("action","buy") or "buy").lower()  # buy/sell
                side=(req.get("side","UP") or "UP").upper()        # UP/DOWN
                usd=float(req.get("usd",1) or 1)
                try:
                    r=_manual_order(action, side, usd)
                    return self._j(200, r)
                except Exception as e:
                    return self._j(200, {"ok":False,"err":repr(e)[:150]})
        return self._j(404,{"err":"nf"})

# 后台预拉缓存: 保证 klines 永远命中缓存, 前端请求永不触发慢查询
def _prewarm():
    while True:
        try:
            klines("5m",120)  # 预拉 K 线
        except Exception: pass
        try:
            d=load_ud()
            for u in d.get("users",{}).values():
                addr=u.get("addr","")
                try: _user_real_trades(addr,d)
                except Exception: pass
                # 预取该用户真实余额(后端缓存, 前端请求只读缓存不同卡)
                try: _user_real_balance(addr)
                except Exception: pass
        except Exception: pass
        time.sleep(50)  # 每50秒预刷新

socketserver.ThreadingTCPServer.allow_reuse_address=True
PORT=int(os.getenv("PORT","8099"))
# 启动后台预拉线程
if os.getenv("NO_PREWARM","")!="1":
    threading.Thread(target=_prewarm,daemon=True).start()
with socketserver.ThreadingTCPServer(("",PORT),H) as s:
    s.serve_forever()

