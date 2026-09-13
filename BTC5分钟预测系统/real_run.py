#!/usr/bin/env python3
import os, json, urllib.request, time, datetime
PK=os.environ.get("POLY_PK","").strip(); SIDE=os.environ.get("SIDE","UP").upper(); USD=float(os.environ.get("USD","1"))
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs
from py_clob_client.order_builder.constants import BUY
def g(u): return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
def parse_dt(s):
    try: return datetime.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
    except: return None
evs=g("https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=startDate&ascending=false")
now=time.time()
live=[]
for e in evs:
    if not e.get("slug","").startswith("btc-updown-5m-"): continue
    st=parse_dt(e.get("startDate") or ""); en=parse_dt(e.get("endDate") or "")
    if st and en and st<=now<en: live.append((e,st,en))
print("now=",now,"进行中5m轮数=",len(live))
if not live:
    print("当前没有进行中的 BTC 5m 轮（可能刚好间隙/时间戳偏差）。列出最近轮供检查：")
    for e in evs:
        if e.get("slug","").startswith("btc-updown-5m-"):
            print("  ", e.get("slug"), e.get("startDate"), e.get("endDate")); break
    raise SystemExit
e,st,en=live[0]
m=(e.get("markets") or [{}])[0]
toks=m.get("clobTokenIds"); toks=json.loads(toks) if isinstance(toks,str) else toks
outs=m.get("outcomes"); outs=json.loads(outs) if isinstance(outs,str) else outs
print("market:", e.get("title")); print("outs:", outs, "tokens:", toks)
token=toks[0] if SIDE=="UP" else toks[1]
cc=ClobClient("https://clob.polymarket.com", key=PK, chain_id=137); cc.set_api_creds(cc.create_or_derive_api_creds())
try:
    ts=cc.get_tick_size(token); print("tick:", ts)
except Exception as ex: print("tick err:", repr(ex)[:160])
try:
    pr=cc.get_price(token,"BUY"); price=float(pr.get("price") if isinstance(pr,dict) else pr); print("价:", price)
except Exception as ex: print("price err:", repr(ex)[:160]); price=0.5
size=round(USD/max(price,0.01),2)
print(f"下单 BUY {SIDE} size={size} @ {price} (~${USD})")
try:
    r=cc.create_and_post_order(OrderArgs(price=price,size=size,side=BUY,token_id=token))
    print("RESULT:", json.dumps(r, default=str)[:500])
except Exception as ex:
    print("ORDER ERR:", repr(ex)[:400])
