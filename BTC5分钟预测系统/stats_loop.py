
# stats_loop.py — 每5分钟: 比对记录轮与真实结算, 更新 stats.json(总体+按阈值分档)
import json,urllib.request,time,os
OUT="/root/polymarket-btc5/stats.json"
REC="/root/polymarket-btc5/rounds.jsonl"
def gl(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
    except: return None
def result_of(ts):
    r=gl(f"https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{ts}")
    if isinstance(r,list) and r:
        m=(r[0].get("markets") or [{}])[0]
        op=m.get("outcomePrices"); outs=m.get("outcomes")
        if op and outs:
            op=json.loads(op) if isinstance(op,str) else op
            try:
                if float(op[0])==1: return "UP"
                if float(op[1])==1: return "DOWN"
            except: pass
    return None
def calc():
    recs=[]
    if os.path.exists(REC):
        for l in open(REC):
            try: recs.append(json.loads(l))
            except: pass
    hit=tot=0; by_thr={}
    for r in recs:
        res=result_of(r["ts"])
        if not res: continue
        tot+=1
        ok = (r["dir"]==res)
        if ok: hit+=1
        d=abs(r.get("dev",0))
        for th in (0.0,0.01,0.02,0.03,0.05):
            if d>=th:
                b=by_thr.setdefault(th,[0,0]); b[0]+=1; b[1]+= 1 if ok else 0
    out={"time":time.strftime("%m-%d %H:%M:%S"),"samples":tot,"overall":round(hit/tot*100,1) if tot else None,
         "by_thr":{str(k):(round(v[1]/v[0]*100,1) if v[0] else None, v[0]) for k,v in by_thr.items()}}
    json.dump(out,open(OUT,"w"))
    return out
while True:
    try: print(calc(), flush=True)
    except Exception as e: print("err",repr(e)[:150], flush=True)
    time.sleep(300)
