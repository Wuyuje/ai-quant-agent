# twap_strategy.py — TWAP偏离策略: 输出当前轮起始/偏离/信号(只读, 不下单)
# v2: 加入 WebSocket 自动重连, 防止断线后卡死不更新
import asyncio, json, time, urllib.request, websockets, os
OUT="/root/polymarket-btc5/twap_state.json"
WS_URL="wss://ws-live-data.polymarket.com"
SUB={"action":"subscribe","subscriptions":[{"topic":"crypto_prices_twap_thirty","type":"update","filters":"{\"symbol\":\"btc/usd\"}"}]}

def gl(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
    except: return None

def round_at(ts):
    r=gl(f"https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{ts}")
    if isinstance(r,list) and r:
        m=(r[0].get("markets") or [{}])[0]
        toks=m.get("clobTokenIds"); toks=json.loads(toks) if isinstance(toks,str) else toks
        return {"slug":f"btc-updown-5m-{ts}","ts":ts,"toks":toks,"ask":m.get("bestAsk"),"bid":m.get("bestBid")}
    return None

def write_state(s):
    tmp=OUT+".tmp"
    json.dump(s,open(tmp,"w"))
    os.replace(tmp,OUT)

async def one_session(last_known_state):
    """建立一次 WebSocket 会话, 返回(是否成功退出, 已知状态)"""
    base=None; last=None; cur_ts=None; state=last_known_state or {}
    last_data=time.time()
    async with websockets.connect(WS_URL, ping_interval=None, open_timeout=15) as ws:
        await ws.send(json.dumps(SUB))
        async def pg():
            while True:
                await asyncio.sleep(10)
                try: await ws.send("PING")
                except: return
        asyncio.create_task(pg())
        while True:
            try:
                msg=await asyncio.wait_for(ws.recv(),timeout=5)
            except Exception:
                # 长时间无数据 -> 判定断线, 触发重连
                if time.time()-last_data>30:
                    return False, state
                continue
            if not msg or msg=="PONG": continue
            try:
                m=json.loads(msg)
                pl=m.get("payload",{})
                # 兼容两种格式: {value} 或 {data:[{value}]}
                v=None
                val=pl.get("value")
                if val is None and pl.get("data"):
                    val=pl["data"][0].get("value") if isinstance(pl["data"],list) and pl["data"] else None
                v=float(val)
            except Exception:
                continue
            if v is None: continue
            last_data=time.time()
            t=int(time.time()); k=(t//300)*300
            if k!=cur_ts:
                cur_ts=k; base=v; last=v
                info=round_at(k)
                state={"ts":k,"base":round(base,2),"last":round(last,2),"dev":0.0,"signal":"观察","round":info}
                write_state(state)
            else:
                last=v; dev=(v-base)/base*100
                info=state.get("round") or round_at(cur_ts)
                remain=(cur_ts+300)-t
                elapsed=(t-cur_ts)
                sig="观察"
                # 最优窗口: 轮内 2.5~3.0 分钟(150~180s), 和实盘bot入场窗口一致(胜率最高)
                if 150<=elapsed<=180 and abs(dev)>=0.02:
                    sig = "UP" if dev>0 else "DOWN"
                state={"ts":cur_ts,"base":round(base,2),"last":round(last,2),"dev":round(dev,4),
                       "remain":remain,"signal":sig,"round":info}
                write_state(state)
            await asyncio.sleep(0.5)

async def main():
    known=None
    while True:
        try:
            ok,known = await one_session(known)
        except Exception as e:
            print("session error:",repr(e)[:120] ,flush=True)
            ok=False
        # 无论正常退出还是异常, 都等待后重连
        if not ok:
            print("reconnecting in 5s...",flush=True)
        await asyncio.sleep(5)

asyncio.run(main())
