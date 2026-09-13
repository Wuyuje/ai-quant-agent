
import asyncio, json, websockets
URL="wss://ws-live-data.polymarket.com"
async def main():
    async with websockets.connect(URL, ping_interval=None) as ws:
        sub={"action":"subscribe","subscriptions":[
            {"topic":"crypto_prices_twap_thirty","type":"update","filters":"{\"symbol\":\"btc/usd\"}"},
            {"topic":"crypto_prices_twap_sixty","type":"update","filters":"{\"symbol\":\"btc/usd\"}"}]}
        await ws.send(json.dumps(sub))
        async def pinger():
            while True:
                await asyncio.sleep(5)
                try: await ws.send("PING")
                except: break
        asyncio.create_task(pinger())
        t0=__import__("time").time(); cnt=0
        while __import__("time").time()-t0<20:
            try:
                msg=await asyncio.wait_for(ws.recv(),timeout=8)
            except Exception as e:
                print("recv timeout/err",repr(e)[:80]); continue
            if msg=="PONG": continue
            try:
                d=json.loads(msg)
                print(str(d)[:220]); cnt+=1
                if cnt>=6: break
            except: pass
        print("got", cnt)
asyncio.run(main())
