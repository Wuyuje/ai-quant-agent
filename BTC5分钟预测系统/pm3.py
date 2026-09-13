
import asyncio, os, json, urllib.request, time, datetime
from polymarket import AsyncSecureClient
PK=os.environ["POLY_PK"]; WALLET=os.environ["POLY_WALLET"]
def g(u): return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
async def main():
    evs=g("https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=startDate&ascending=false")
    now=time.time(); live=[]
    for e in evs:
        if not e.get("slug","").startswith("btc-updown-5m-"): continue
        try:
            st=datetime.datetime.fromisoformat((e.get("startDate") or "").replace("Z","+00:00")).timestamp()
            en=datetime.datetime.fromisoformat((e.get("endDate") or "").replace("Z","+00:00")).timestamp()
        except: continue
        if st<=now<en: live.append(e)
    print("live:",len(live))
    if not live: return
    e=live[0]; m=(e.get("markets") or [{}])[0]
    toks=m.get("clobTokenIds"); toks=json.loads(toks) if isinstance(toks,str) else toks
    token=toks[0]; print("slug",e.get("slug"),"ask",m.get("bestAsk"))
    client=await AsyncSecureClient.create(private_key=PK, wallet=WALLET)
    try:
        resp=await client.place_market_order(token_id=token, side="BUY", amount="1")
        print("ORDER ok:",getattr(resp,"ok",None),"id:",getattr(resp,"order_id",None),"msg:",getattr(resp,"message",None))
        if getattr(resp,"ok",False):
            try: print("settled:",await client.wait_for_order_fill_settlement(resp))
            except Exception as ex: print("settle:",repr(ex)[:150])
    except Exception as ex:
        print("ORDER ERR:",repr(ex)[:250])
    finally:
        try: await client.close()
        except Exception: pass
asyncio.run(main())
