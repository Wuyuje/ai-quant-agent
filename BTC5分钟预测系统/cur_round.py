
import json, urllib.request, time
def g(u):
    try:
        return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
    except Exception as e:
        return {"__err__":str(e)[:120]}
now=int(time.time())
# 推算当前轮(5m=300s对齐)
cur=(now//300)*300
print("now",now,"推算当前轮ts",cur)
for dt in (0,-300,300,-600):
    ts=cur+dt; slug=f"btc-updown-5m-{ts}"
    r=g(f"https://gamma-api.polymarket.com/events?slug={slug}")
    ok = isinstance(r,list) and len(r)>0
    print(f"  {slug}: {'存在' if ok else '无'}", ("| title="+ (r[0].get('title','') if ok else '') ) if ok else "")
    if ok:
        m=(r[0].get('markets') or [{}])[0]
        print("     accepting:", m.get('acceptingOrders'), "enableOrderBook:", m.get('enableOrderBook'), "bestAsk:", m.get('bestAsk'), "tokens:", (json.loads(m['clobTokenIds']) if isinstance(m.get('clobTokenIds'),str) else m.get('clobTokenIds'))[:2] if m.get('clobTokenIds') else None)
