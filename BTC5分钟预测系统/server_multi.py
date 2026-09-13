#!/usr/bin/env python3
# server_multi.py v2 — 多用户预测系统后端 + Polygon 校验 + 可插拔下单
# 运行: ADMIN=0x.. POLY_PK=.. DEMO=1 python3 server_multi.py --port 8891
import http.server, socketserver, json, os, sys, time, threading
from urllib.parse import urlparse, parse_qs

ROOT=os.path.dirname(os.path.abspath(__file__)); DB_F=os.path.join(ROOT,"users_db.json")
ADMIN=os.getenv("ADMIN","").lower().strip()
PORT=int(sys.argv[sys.argv.index("--port")+1]) if "--port" in sys.argv else 8891
DEMO=os.getenv("DEMO","1").strip()=="1"
POLY_PK=os.getenv("POLY_PK","").strip()
POLY_MARKET=os.getenv("POLY_MARKET","").strip()   # 当前 BTC5 市场id/token(可选)

def load_db():
    if os.path.exists(DB_F):
        try: return json.load(open(DB_F))
        except: pass
    return {"users":{}, "global":{"auto_enabled":True,"threshold":0.08,"size_usdc":5,"require_polygon":True}}
def save_db(db): json.dump(db, open(DB_F,"w"), indent=1)
db=load_db(); lock=threading.Lock()
def ensure_user(a):
    a=(a or "").lower().strip()
    if not (a.startswith("0x") and len(a)==42): return None
    if a not in db["users"]:
        db["users"][a]={"addr":a,"created":int(time.time()),"authorized":False,"auto":False,
                        "size_usdc":db["global"].get("size_usdc",5),"chain":"Polygon","polygon_ok":False,
                        "wins":0,"loss":0,"equity":0,"enabled":True}
        save_db(db)
    return db["users"][a]

# ---- 下单适配层(无 pk 时 demo) ----
def place_order(addr, side, usdc, price):
    if DEMO or not POLY_PK:
        return {"ok":True,"demo":True,"msg":f"[demo] {side} ${usdc} @ {price}"}
    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import OrderArgs
        from py_clob_client.order_builder.constants import BUY
        cc=ClobClient("https://clob.polymarket.com", key=POLY_PK, chain_id=137)
        cc.set_api_creds(cc.create_or_derive_api_creds())
        if not POLY_MARKET: return {"ok":False,"err":"no POLY_MARKET(token)"}
        args=OrderArgs(price=price, size=usdc, side=BUY, token_id=POLY_MARKET)
        r=cc.create_and_post_order(args)
        return {"ok":True,"order":str(r)[:200]}
    except Exception as e:
        return {"ok":False,"err":str(e)[:200]}

STATE={"ok":False}
def loop():
    global STATE
    while True:
        STATE={"ok":True,"price":None,"tech":"DOWN","super":"-","rsi":None,"boll":"",
               "pu":.5,"pd":.5,"side":None,"reco":"观望","ts":time.strftime("%H:%M:%S"),"history":[],"kl":[]}
        time.sleep(2)
threading.Thread(target=loop,daemon=True).start()

class H(http.server.BaseHTTPRequestHandler):
    def _j(self,c,o):
        b=json.dumps(o,ensure_ascii=False).encode(); self.send_response(c)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Content-Length",str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def _page(self,name):
        p=os.path.join(ROOT,name)
        if os.path.exists(p):
            b=open(p,"rb").read(); self.send_response(200)
            self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Content-Length",str(len(b)))
            self.end_headers(); self.wfile.write(b); return True
        return False
    def log_message(self,*a): pass
    def do_GET(self):
        u=urlparse(self.path); q=parse_qs(u.query)
        with lock:
            if u.path=="/api/state": return self._j(200,STATE)
            if u.path=="/api/onboard":
                # 启动选择校验: 只支持 Polygon; 若选BSC/其它 -> 提示需跨链
                net=(q.get("net",["Polygon"])[0])
                if net.lower().startswith("polygon"):
                    return self._j(200,{"ok":True,"need":["USDC(Polygon)","少量 MATIC(gas)"],"msg":"正确网络: Polygon"})
                return self._j(200,{"ok":False,"msg":"仅支持 Polygon 网络。币安链(BSC)等资产需用跨链桥或从交易所选择 Polygon 网络提币，直接转账无法到账。"})
            if u.path=="/api/me":
                a=(q.get("addr",[""])[0]); return self._j(200,{"user":db["users"].get(a.lower()),"isAdmin":a.lower()==ADMIN})
            if u.path=="/api/admin/users":
                if (q.get("addr",[""])[0]).lower()!=ADMIN: return self._j(403,{"err":"not admin"})
                return self._j(200,{"users":list(db["users"].values()),"global":db["global"]})
            if u.path in ("/","/index.html"): return self._page("index.html") or self._j(404,{"err":"no index"})
            if u.path=="/admin.html": return self._page("admin.html") or self._j(404,{"err":"no admin"})
        return self._j(404,{"err":"not found"})
    def do_POST(self):
        u=urlparse(self.path); ln=int(self.headers.get("Content-Length","0") or 0)
        try: req=json.loads(self.rfile.read(ln).decode() or "{}")
        except: req={}
        with lock:
            if u.path=="/api/auth":
                usr=ensure_user(req.get("addr","")); 
                if not usr: return self._j(400,{"err":"bad addr"})
                usr["authorized"]=True; usr["chain"]=req.get("chain","Polygon")
                usr["polygon_ok"]=bool(req.get("polygon_ok", usr.get("polygon_ok",False)))
                save_db(db); return self._j(200,{"user":usr})
            if u.path=="/api/config":
                a=(req.get("addr","")).lower(); usr=db["users"].get(a)
                if not usr: return self._j(404,{"err":"no user"})
                if "auto" in req: usr["auto"]=bool(req["auto"])
                if "size_usdc" in req: usr["size_usdc"]=float(req["size_usdc"])
                save_db(db); return self._j(200,{"user":usr})
            if u.path=="/api/order":   # 手动/自动下单入口
                a=(req.get("addr","")).lower(); usr=db["users"].get(a)
                if not usr or not usr.get("authorized"): return self._j(403,{"err":"not authorized"})
                r=place_order(a, req.get("side","YES"), float(req.get("usdc",5)), float(req.get("price",0.5)))
                return self._j(200,r)
            if u.path=="/api/admin/set":
                if (req.get("addr","")).lower()!=ADMIN: return self._j(403,{"err":"not admin"})
                t=(req.get("target","")).lower()
                if t in db["users"]:
                    for k in ("enabled","auto","authorized","polygon_ok"):
                        if k in req: db["users"][t][k]=bool(req[k])
                if isinstance(req.get("global"),dict): db["global"].update(req["global"])
                save_db(db); return self._j(200,{"ok":True,"global":db["global"]})
        return self._j(404,{"err":"bad"})
with socketserver.ThreadingTCPServer(("",PORT),H) as srv:
    print("poly multi-dash v2 on :",PORT,"demo=",DEMO,"admin=",ADMIN or "(unset)")
    srv.serve_forever()
