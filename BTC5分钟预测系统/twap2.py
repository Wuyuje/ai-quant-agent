
import asyncio, json, time, datetime, urllib.request, websockets, re
def gl(u): return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
def rounds():
    evs=gl("https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=startDate&ascending=false")
    rs=[]
    for e in evs:
        m=re.match(r"btc-updown-5m-(\d+)", e.get("slug",""))
        if m: rs.append(int(m.group(1)))
    return sorted(set(rs))
now=time.time()
rs=rounds()
# 取最接近现在的轮ts(可能略早/略晚)
near=sorted(rs, key=lambda t: abs(t-now))[:5]
print("now",int(now), "最近轮ts:", [(t, round((t-now)/60,1),"'分钟后'") for t in near])
# 选 begin<=now<begin+300 的; 若无则用最接近且刚过去的
cur=None
for t in near:
    if t<=now<t+300: cur=t; break
if cur is None:
    past=[t for t in rs if t<=now]
    cur=max(past) if past else near[0]
end=cur+300
print("采用轮起始",cur, "剩余", round(end-now),"s (若为负表示该轮已结束)")
async def main():
    base=None; last=None
    async with websockets.connect("wss://ws-live-data.polymarket.com", ping_interval=None) as ws:
        await ws.send(json.dumps({"action":"subscribe","subscriptions":[{"topic":"crypto_prices_twap_thirty","type":"update","filters":"{\"symbol\":\"btc/usd\"}"}]}))
        async def pg():
            while True:
                await asyncio.sleep(5)
                try: await ws.send("PING")
                except: break
        asyncio.create_task(pg())
        t0=time.time()
        while time.time()-t0<45:
            try: msg=await asyncio.wait_for(ws.recv(),timeout=5)
            except: continue
            if msg=="PONG": continue
            try: v=float(json.loads(msg).get("payload",{}).get("value"))
            except: continue
            if base is None: base=v
            last=v
            print(f"剩余{round(end-time.time()):>4}s TWAP={v:.2f} dev={(v-base)/base*100:+.3f}%", flush=True)
        print("本段: base",base,"last",last,"dev%",round((last-base)/base*100,3))
asyncio.run(main())
