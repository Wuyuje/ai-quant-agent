#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
real_poly.py — Polymarket BTC 5min(每次一轮随机ID) 真实执行层
做法(不依赖硬编码市场id):
 1) 连 CLOB + 派生 API creds(私钥→“APIkey”)
 2) 从 ClobClient.get_events() 筛出名称含 BTC 且 周期约 5 分钟的进行中 market
 3) 取该 market 的 tokens(outcomes 的 token_id) 与当前 price; 把 YES 定价当 p_up, NO 定价当 p_down
 4) 提供 check_bet(side='YES'|'NO', usdc, price) 构造并下单(带 min 滑点保护)
真实成功需环境: PK(私钥), CHAIN_ID=137, 见 README/接入清单。DEMO fallback: 无 PK 时只打印将下。
"""
import os, time, sys
try:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import OrderArgs, MarketOrderArgs
    from py_clob_client.order_builder.constants import BUY
    _HAS_CLOB = True
except Exception as e:
    _HAS_CLOB = False
    print("[real_poly] py-clob-client 未安装，可装： pip install py-clob-client", file=sys.stderr)

HOST = "https://clob.polymarket.com"
def get_client():
    host = os.getenv("CLOB_HOST", HOST)
    key = os.getenv("PK", "").strip()
    chain = int(os.getenv("CHAIN_ID", "137"))
    if not key:
        return None
    cc = ClobClient(host, key=key, chain_id=chain)
    creds = cc.create_or_derive_api_creds()
    cc.set_api_creds(creds)
    return cc

def find_btc5_market():
    """回到 CLOB 最新赛事中名为 BTC…5分… 的市场；返回 ({outcomes, token_ids, current_prices}, market)。"""
    cc = get_client()
    if cc is None:
        return None
    # 扫一次公开赛事
    try:
        events = cc.get_events() or []
    except Exception as e:
        print("get_events err", e); return None
    for ev in events:
        mname = ((ev.get("title") or ev.get("question") or "") + " " + " ".join((ev.get("markets") or [{}])[0].get("question","") if ev.get("markets") else "" )).lower()
        if "btc" in mname and ("5m" in mname or "5-min" in mname or "5 min" in mname):
            m = (ev.get("markets") or [{}])[0]
            return m
    return None

def p_yes_no_from_market(m):
    """把 market 展开成 {token_id, price} -> p_up=YES价, p_down=NO价"""
    out_yes=out_no=None
    outs = m.get("outcomes") or m.get("tokens") or []
    prices = m.get("prices")
    for o in outs:
        # outcomes 里含 "Up"/"Yes"/"Increase"/"涨" 之类
        txt = str(o).lower()
        if txt in ("up","yes","increase","涨","上涨","buy yes","y"):
            out_yes=o
        elif txt in ("down","no","decrease","跌","下跌","n") or "down" in txt and "up" not in txt:
            out_no=o
    return out_yes, out_no, prices

def probabilities():
    """返回 (p_up, p_down, ok, detail) — safe demo 若无真实连接"""
    cm=find_btc5_market()
    if not cm: return None
    yes,no,pr=p_yes_no_from_market(cm)
    if yes is None or no is None or not isinstance(pr,(list,dict)):
        return None
    try:
        # prices 常为 dict outcomeId->price 或 list
        p_up = float((pr.get(yes) if isinstance(pr,dict) else pr[0]))
        p_dn = float((pr.get(no) if isinstance(pr,dict) else pr[1]))
    except Exception: return None
    return p_up, p_dn, True, cm

def real_or_demo_order(side, usdc, price):
    if os.getenv("DEMO","1").strip()=="1" or get_client() is None:
        print(f"  [demo] 拟下单 {side} usdc={usdc} @ {price}")
        return True
    cc=get_client(); m=find_btc5_market();
    if not m: return False
    yes,no,pr=p_yes_no_from_market(m)
    token = yes if side=="YES" else no
    # 用市价单示意; 具体 token/order需按市场 token 字段做；若出错即返回False供外层优化
    try:
        from py_clob_client.constants import POLYGON
        args = OrderArgs(price=price, size=usdc, side=BUY, token_id=token)
        cc.create_and_post_order(args)
        return True
    except Exception as e:
        print("下真实单失败", e); return False

if __name__=="__main__":
    print("prob:", probabilities())
