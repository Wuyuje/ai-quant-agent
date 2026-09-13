
import json,urllib.request,time
def gl(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=12).read())
    except: return None
def result_of(ts):
    r=gl(f"https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{ts}")
    if isinstance(r,list) and r:
        m=(r[0].get("markets") or [{}])[0]
        op=m.get("outcomePrices"); outs=m.get("outcomes")
        if op and outs:
            op=json.loads(op) if isinstance(op,str) else op; outs=json.loads(outs) if isinstance(outs,str) else outs
            try:
                up=float(op[0]); dn=float(op[1])
                if up==1: return "UP"
                if dn==1: return "DOWN"
            except: pass
    return None
now=int(time.time()); base_ts=(now//300)*300
rows=[]
for i in range(1,30):
    ts=base_ts-300*i
    res=result_of(ts)
    if res: rows.append((ts,res))
print("取到已结算轮:",len(rows))
# 与 rounds.jsonl 记录的 dir 比对
try: recs={r["ts"]:r for r in [json.loads(l) for l in open("/root/polymarket-btc5/rounds.jsonl")]}
except: recs={}
print("recorder已记录轮:",len(recs))
hit=tot=0
for ts,res in rows:
    r=recs.get(ts)
    if not r: continue
    tot+=1
    if r["dir"]==res: hit+=1
if tot: print(f"TWAP偏离方向 vs 真实结算: {hit}/{tot} = {round(hit/tot*100,1)}%")
else: print("暂无重叠(recorder刚启动, 需稍后)")
# 也统计: 用最终结果分布
from collections import Counter
print("最近已结算结果分布:", Counter([r for _,r in rows]))
