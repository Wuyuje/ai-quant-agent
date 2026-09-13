
import asyncio, json, time, datetime, urllib.request, websockets, re
def gl(u): return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
def list_rounds():
    evs=gl("https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=startDate&ascending=false")
    rs=[]
    for e in evs:
        s=e.get("slug","")
        m=re.match(r"btc-updown-5m-(\d+)", s)
        if m: rs.append((int(m.group(1)), s, (e.get("markets") or [{}])[0]))
    rs.sort()
    return rs
async def main():
    rs=list_rounds(); now=time.time()
    print("轮数:",len(rs),"最新ts:",rs[-1][0],"now:",int(now))
    # 找现在所处轮: ts <= now < ts+300
    cur=None
    for ts,slug,mkt in rs:
        if ts<=now<ts+300: cur=(ts,slug,mkt); break
    if not cur:
        print("当前无正好进行中的5m轮; 最近的前后:", [(ts, slug) for ts,slug,_ in rs[-3:]])
        return
    ts,slug,mkt=cur
    end=ts+300
    print("本轮:",slug,"结束于", datetime.datetime.fromtimestamp(end).strftime("%H:%M:%S"), "剩余", round(end-now))
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
        while time.time()-t0<60 and time.time()<end+5:
            try: msg=await asyncio.wait_for(ws.recv(),timeout=5)
            except: continue
            if msg=="PONG": continue
            try:
                d=json.loads(msg); v=d.get("payload",{}).get("value")
            except: continue
            if v is None: continue
            v=float(v)
            if base is None: base=v
            last=v
            dev=(v-base)/base*100
            print(f"剩余{round(end-time.time()):>3}s TWAP={v:.2f} 偏离{dev:+.3f}%", flush=True)
        print("轮末: 基准",base,"末值",last,"偏离%",round((last-base)/base*100,3))
asyncio.run(main())
