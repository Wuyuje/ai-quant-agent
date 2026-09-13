#!/usr/bin/env python3
# serve.py — Polymarket BTC5 共振 量化台 简易后端（标准库）：
# 托管 index.html(/)，并在后台线程算币安信号+共振，写 /state.json 供前端高频读取。
# 运行: DEMO=1 python3 serve.py --port 8890   (DEMO: 只给状态/建议，不下真实单)
import http.server, socketserver, threading, json, time, os, math, sys
from datetime import datetime
ROOT = os.path.dirname(os.path.abspath(__file__))
DEMO = os.getenv("DEMO", "1").strip() == "1"

# ---- 币安信号(轻量实现，供状态更新) ----
def get_kl(interval="5m", limit=220):
    try:
        import ccxt
        ex = ccxt.binance({"enableRateLimit": True})
        rows = ex.fetch_ohlcv("BTC/USDT", interval, limit=limit)
        return rows
    except Exception as e:
        return None

def sup_tr(rows):
    # simplified: 返回 last close, slope7/25 naive → SUPER示向 up/down
    if not rows or len(rows) < 30: return None
    cv=[r[4] for r in rows]; last=cv[-1]
    d7= cv[-1]-cv[-8]; d25= cv[-1]-cv[-26]
    up = d7>0 and d25>=0 if d7 else (d25>=0)
    return {"dir":"UP" if up else "DOWN","last":last}

def build_state():
    rows=get_kl()
    st={"ok":False}
    if rows:
        last=rows[-1][4]; prev=rows[-6][4] if len(rows)>6 else rows[0][4]
        su=sup_tr(rows)
        tech = su["dir"] if su else "UP"
        p_up=p_dn=0.5
        # 假共振：真实对接时在此读 Polymarket，这里以 tech 给例子概率，避免无 polymarket仍可看
        side = ("YES" if tech=="UP" else "NO") if not DEMO else None
        reco= "观望" if DEMO else f"BUY {side}"
        st={"ok":True,"price":last,"chg":round((last-prev)/prev*100 if prev else 0,2),
            "super": su["dir"] if su else "-", "rsi":None, "tech":tech,
            "pu":p_up,"pd":p_dn,"side":side,"reco":reco,
            "ts":datetime.now().strftime("%H:%M:%S"),
            "rounds":[{"tech":tech,"side":side,"res":"-"}],
            "history":[]}
    return st

STATE=build_state()
def loop():
    global STATE
    while True:
        try: STATE=build_state()
        except Exception as e: STATE={"ok":False,"err":str(e)}
        time.sleep(1.0)
threading.Thread(target=loop,daemon=True).start()

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        if self.path.startswith("/state.json"):
            b=json.dumps(STATE).encode(); self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
        else:
            p=os.path.join(ROOT,"index.html")
            if os.path.exists(p):
                b=open(p,"rb").read(); self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
            else:
                self.send_response(404); self.end_headers(); self.wfile.write(b"no index")

PORT=int(sys.argv[sys.argv.index("-port")+1] if "-port" in sys.argv else 8890)
with socketserver.ThreadingTCPServer(("",PORT),H) as srv:
    print("resonance dashboard on :",PORT," demo=",DEMO)
    srv.serve_forever()
