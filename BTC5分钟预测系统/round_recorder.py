
import asyncio, json, time, urllib.request, websockets
OUT="/root/polymarket-btc5/rounds.jsonl"
def gl(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
    except: return None
def round_info(ts):
    r=gl(f"https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{ts}")
    if isinstance(r,list) and r:
        m=(r[0].get("markets") or [{}])[0]
        return {"slug":f"btc-updown-5m-{ts}","ask":m.get("bestAsk"),"bid":m.get("bestBid")}
    return {"slug":f"btc-updown-5m-{ts}"}
async def main():
    ticks={}
    async with websockets.connect("wss://ws-live-data.polymarket.com", ping_interval=None) as ws:
        await ws.send(json.dumps({"action":"subscribe","subscriptions":[{"topic":"crypto_prices_twap_thirty","type":"update","filters":"{\"symbol\":\"btc/usd\"}"}]}))
        async def pg():
            while True:
                await asyncio.sleep(5)
                try: await ws.send("PING")
                except: break
        asyncio.create_task(pg())
        last=0
        while True:
            try: msg=await asyncio.wait_for(ws.recv(),timeout=4)
            except: msg=None
            if msg and msg!="PONG":
                try:
                    v=float(json.loads(msg).get("payload",{}).get("value")); t=int(time.time()); k=(t//300)*300
                    ticks.setdefault(k,[]).append(v)
                except: pass
            now=int(time.time()); k=(now//300)*300
            if last and k!=last:
                arr=ticks.pop(last,[])
                if len(arr)>=3:
                    base=arr[0]; lastv=arr[-1]; dev=(lastv-base)/base*100
                    rec={"ts":last,"t":time.strftime("%m-%d %H:%M"),"base":round(base,2),"last":round(lastv,2),"dev":round(dev,4),
                         "dir":"UP" if dev>0 else ("DOWN" if dev<0 else "FLAT")}
                    rec.update(round_info(last))
                    with open(OUT,"a") as f: f.write(json.dumps(rec,ensure_ascii=False)+"\n")
                    print("rec", json.dumps(rec,ensure_ascii=False), flush=True)
            last=k
asyncio.run(main())
