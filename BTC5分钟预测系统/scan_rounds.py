
import json,urllib.request,re,time
def gl(u): return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
now=int(time.time()); seen={}
# gamma 多页(含 closed)
for page in range(0,6):
    u=f"https://gamma-api.polymarket.com/markets?closed=true&limit=500&offset={page*500}"
    try: ms=gl(u)
    except Exception as e: print("err",e); break
    for m in ms:
        s=(m.get("slug") or "")
        mt=re.match(r"btc-updown-5m-(\d+)", s)
        if mt: seen[int(mt.group(1))]=m
    if len(ms)<500: break
ts=sorted(seen)
print("拿到5m轮数:",len(ts))
near=[t for t in ts if abs(t-now)<3600*6]
print("now:",now,"(UTC",time.strftime('%Y-%m-%d %H:%M',time.gmtime(now)),")")
print("±6h内轮数:",len(near))
for t in (near[:3]+near[-3:]) if near else []:
    print("  ts",t, time.strftime('%m-%d %H:%M',time.gmtime(t)), "closed:", seen[t].get("closed"), "active:",seen[t].get("active"))
# 最新几个ts
print("最新5个轮ts:", [ (t, time.strftime('%m-%d %H:%M',time.gmtime(t))) for t in ts[-5:] ])
print("最早5个轮ts:", [ (t, time.strftime('%m-%d %H:%M',time.gmtime(t))) for t in ts[:5] ])
