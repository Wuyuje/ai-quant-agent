
import asyncio, os, json, urllib.request, time
from polymarket import AsyncSecureClient
PK=os.environ["POLY_PK"]; WALLET=os.environ.get("POLY_WALLET","0x9999c0FC24d4468aFa840fC5C1b5f01775B5eE79")
def g(u):
    return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
async def main():
    evs=g("https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=startDate&ascending=false")
    now=time.time(); live=[]
    for e in evs:
        if not e.get("slug","").startswith("btc-updown-5m-"): continue
        try:
            st=__import__("datetime").datetime.fromisoformat((e.get("startDate") or "").replace("Z","+00:00")).timestamp()
            en=__import__("datetime").datetime.fromisoformat((e.get("endDate") or "").replace("Z","+00:00")).timestamp()
        except: continue
        if st<=now<en: live.append(e)
    print("live 5m:", len(live), flush=True)
    if not live: print("no live"); return
    e=live[0]; m=(e.get("markets") or [{}])[0]
    toks=m.get("clobTokenIds"); toks=json.loads(toks) if isinstance(toks,str) else toks
    token=toks[0]
    print("slug:",e.get("slug"),"token:",token,"ask:",m.get("bestAsk"),"bid:",m.get("bestBid"), flush=True)
    client=await AsyncSecureClient.create(private_key=PK, wallet=WALLET)
    try:
        resp=await client.place_market_order(token_id=token, side="BUY", amount="1")
        print("ORDER ok:",getattr(resp,"ok",None),"order_id:",getattr(resp,"order_id",None),"msg:",getattr(resp,"message",None), flush=True)
        if getattr(resp,"ok",False):
            try:
                h=await client.wait_for_order_fill_settlement(resp); print("settled:",h, flush=True)
            except Exception as ex: print("settle:",repr(ex)[:150], flush=True)
    except Exception as ex:
        print("ORDER ERR:", repr(ex)[:250], flush=True)
    finally:
        try: await client.close()
        except Exception: pass
asyncio.run(main())
