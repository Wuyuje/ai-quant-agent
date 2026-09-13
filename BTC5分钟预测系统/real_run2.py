
import os, json, urllib.request, time, datetime
PK=os.environ["POLY_PK"]; SIDE=os.environ.get("SIDE","UP").upper(); USD=float(os.environ.get("USD","1"))
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY
def g(u): return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=15).read())
def parse_dt(s):
    try: return datetime.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
    except: return None
evs=g("https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=startDate&ascending=false")
now=time.time(); live=[]
for e in evs:
    if not e.get("slug","").startswith("btc-updown-5m-"): continue
    st=parse_dt(e.get("startDate") or ""); en=parse_dt(e.get("endDate") or "")
    if st and en and st<=now<en: live.append(e)
if not live: print("no live 5m"); raise SystemExit
e=live[0]; m=(e.get("markets") or [{}])[0]
toks=m.get("clobTokenIds"); toks=json.loads(toks) if isinstance(toks,str) else toks
token=toks[0] if SIDE=="UP" else toks[1]
cc=ClobClient("https://clob.polymarket.com", key=PK, chain_id=137)
cc.set_api_creds(cc.create_or_derive_api_creds())
price=0.5
try:
    p=cc.get_price(token,"BUY"); price=float(p.get("price") if isinstance(p,dict) else p)
except: pass
size=round(USD/max(price,0.01),2)
print("token",token,"price",price,"size",size)
args=OrderArgs(price=price, size=size, side=BUY, token_id=token)
signed=cc.create_order(args)
print("signed ok")
r=cc.post_order(signed, OrderType.GTC)
print("RESULT:", json.dumps(r, default=str)[:500])
