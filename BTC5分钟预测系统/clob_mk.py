
import json, urllib.request, re, time
def g(u):
    req=urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"})
    return json.loads(urllib.request.urlopen(req,timeout=15).read())
# CLOB markets 列表(公开)
try:
    d=g("https://clob.polymarket.com/markets?limit=100")
    print("clob markets type:", type(d).__name__)
    items = d.get("data") if isinstance(d,dict) else d
    print("count:", len(items) if items else 0)
    hits=[]
    for m in (items or []):
        if not isinstance(m,dict): continue
        q=(m.get("question") or m.get("slug") or "")
        if "btc" in q.lower() and "5" in q and ("min" in q.lower() or "up" in q.lower()):
            hits.append(m)
    print("btc5 hits:", len(hits))
    for m in hits[:6]:
        print(" -", m.get("question"), "| slug:", m.get("slug"), "| accepting:", m.get("acceptingOrders"), "| tokens:", (m.get("tokens") or [])[:2])
except Exception as e:
    print("ERR:", repr(e)[:300])
