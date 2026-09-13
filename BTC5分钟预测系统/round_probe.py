
import asyncio, json, time, urllib.request, websockets, re
def gl(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
    except: return None
def round_at(ts):
    r=gl(f"https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{ts}")
    if isinstance(r,list) and r:
        m=(r[0].get("markets") or [{}])[0]
        toks=m.get("clobTokenIds"); toks=json.loads(toks) if isinstance(toks,str) else toks
        return {"slug":f"btc-updown-5m-{ts}","ts":ts,"toks":toks,"ask":m.get("bestAsk"),"bid":m.get("bestBid"),"accepting":m.get("acceptingOrders")}
    return None
async def main():
    results=[]
    ticks={}  # ts -> list of twap
    async with websockets.connect("wss://ws-live-data.polymarket.com", ping_interval=None) as ws:
        await ws.send(json.dumps({"action":"subscribe","subscriptions":[{"topic":"crypto_prices_twap_thirty","type":"update","filters":"{\"symbol\":\"btc/usd\"}"}]}))
        async def pg():
            while True:
                await asyncio.sleep(5)
                try: await ws.send("PING")
                except: break
        asyncio.create_task(pg())
        last_ts=0
        t_end=time.time()+250
        while time.time()<t_end:
            try: msg=await asyncio.wait_for(ws.recv(),timeout=4)
            except: msg=None
            if msg and msg!="PONG":
                try:
                    v=float(json.loads(msg).get("payload",{}).get("value"))
                    t=int(time.time()); k=(t//300)*300
                    ticks.setdefault(k,[]).append(v)
                except: pass
            # 每轮结束时评估
            now=int(time.time()); k=(now//300)*300
            if k!=last_ts and last_ts!=0:
                # 评估上一轮
                arr=ticks.get(last_ts,[])
                if len(arr)>=3:
                    base=arr[0]; last=arr[-1]
                    dev=(last-base)/base*100
                    direction = "UP" if dev>0 else ("DOWN" if dev<0 else "FLAT")
                    results.append({"ts":last_ts,"base":base,"last":last,"dev":round(dev,3),"dir":direction})
                    print(f"轮 {last_ts}: base={base:.1f} last={last:.1f} dev={dev:+.3f}% → 判定 {direction}", flush=True)
            last_ts=k
    print("== 汇总 ==")
    for r in results: print(r)
asyncio.run(main())
