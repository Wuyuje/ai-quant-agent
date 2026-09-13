
import asyncio, os, time
from polymarket import AsyncSecureClient, AsyncPublicClient
PK=os.environ["POLY_PK"]; WALLET=os.environ.get("POLY_WALLET","0x9999c0FC24d4468aFa840fC5C1b5f01775B5eE79")
async def main():
    async with AsyncPublicClient() as pub:
        pages=pub.list_markets(closed=False)
        cands=[]
        async for m in pages.iter_items():
            slug=(getattr(m,"slug","") or "")
            if slug.startswith("btc-updown-5m-"):
                try: tok=m.outcomes.yes.token_id
                except Exception: tok=None
                cands.append((slug,tok,m))
        print("5m markets found:", len(cands))
        # 逐个试订单簿, 找有簿的
        chosen=None
        for slug,tok,m in cands:
            if not tok: continue
            try:
                ob=await pub.get_order_book(tok) if hasattr(pub,"get_order_book") else None
                bids=getattr(ob,"bids",None); asks=getattr(ob,"asks",None)
                nb=len(bids) if bids is not None else 0; na=len(asks) if asks is not None else 0
                print(" ", slug, "bids:",nb,"asks:",na)
                if nb or na:
                    chosen=(slug,tok,m); break
            except Exception as e:
                print(" ", slug, "ob err:", repr(e)[:80])
        if not chosen:
            print("== 当前所有5m市场订单簿为空(轮间隙), 稍后再试 ==")
            return
        slug,tok,m=chosen; print("chosen:",slug,"token:",tok)
    client=await AsyncSecureClient.create(private_key=PK, wallet=WALLET)
    try:
        resp=await client.place_market_order(token_id=tok, side="BUY", amount="1")
        print("ORDER ok:",getattr(resp,"ok",None),"order_id:",getattr(resp,"order_id",None),"msg:",getattr(resp,"message",None))
        if getattr(resp,"ok",False):
            try:
                h=await client.wait_for_order_fill_settlement(resp); print("settled:",h)
            except Exception as e: print("settle:",repr(e)[:150])
    finally:
        try: await client.close()
        except Exception: pass
asyncio.run(main())
