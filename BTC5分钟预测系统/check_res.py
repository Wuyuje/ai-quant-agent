
import json,urllib.request,time
def gl(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
    except Exception as e: return {"err":str(e)[:100]}
now=int(time.time()); past=(now//300)*300-600  # 约2轮前(已结束)
for ts in (past, past-300):
    slug=f"btc-updown-5m-{ts}"
    r=gl(f"https://gamma-api.polymarket.com/events?slug={slug}")
    if isinstance(r,list) and r:
        m=(r[0].get("markets") or [{}])[0]
        print(slug, "| outcomes:", m.get("outcomes"), "| outcomePrices:", m.get("outcomePrices"), "| closed:", m.get("closed"), "| umaResolutionStatus:", m.get("umaResolutionStatus"))
    else:
        print(slug, "not found", r if isinstance(r,dict) else "")
