#!/usr/bin/env python3
import http.server,socketserver,json,os
ROOT="/root/polymarket-btc5"
def rd(p,d=None):
    try: return json.load(open(os.path.join(ROOT,p)))
    except: return d
def wr(p,o): json.dump(o,open(os.path.join(ROOT,p),"w"))
PAGE='<!DOCTYPE html><html lang=zh><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>BTC5 交易台</title>\n<style>body{background:#070c16;color:#e6eefb;font-family:Segoe UI,system-ui,Arial,"PingFang SC";padding:18px;max-width:1000px;margin:auto}\n.card{background:#0e1626;border:1px solid #1b2740;border-radius:12px;padding:14px;margin-bottom:12px}\n.big{font-size:34px;font-weight:700}.mut{color:#8fa0bf;font-size:12px}\nbutton{padding:9px 16px;margin-right:8px;border:0;border-radius:8px;font-size:15px;cursor:pointer}.go{background:#1fdd8b;color:#042}.st{background:#ff5a5a;color:#120}\ntable{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}td,th{border-bottom:1px solid #1b2740;padding:7px;text-align:left}th{color:#8fa0bf;font-weight:400}\n.up{color:#ff5a5a}.dn{color:#1fdd8b}.tag{font-size:12px;padding:3px 9px;border-radius:99px;background:#12203a;border:1px solid #1b2740}\n</style></head><body>\n<h2>BTC 5m Up/Down · 自动交易台</h2>\n<div class=card>\n <div class=mut>系统控制</div>\n <div style="margin:8px 0"><button class=go onclick="ctl(\'start\')">▶ 启动</button><button class=st onclick="ctl(\'stop\')">⏸ 停止</button> <span id=st class=tag>…</span></div>\n</div>\n<div class=card>\n <div class=mut>TWAP 策略状态（结算源 Chainlink TWAP）</div>\n <div class=big id=dev>—</div>\n <div>当前轮：<span id=slug>—</span> 剩余 <b id=rem>—</b>s</div>\n <div>起始TWAP <b id=base>—</b> · 当前TWAP <b id=last>—</b></div>\n <div>信号：<b id=sig>—</b> &nbsp; 盘口 ask <b id=ask>—</b></div>\n</div>\n<div class=card><div class=mut>交易记录（本系统）</div>\n<table id=t><thead><tr><th>时间</th><th>方向</th><th>金额</th><th>信号强度</th><th>BTC价</th></tr></thead><tbody></tbody></table></div>\n<script>\nfunction ctl(a){fetch(\'/api/\'+a).then(r=>r.json()).then(()=>ref())}\nfunction ref(){\n fetch(\'/api/state\').then(r=>r.json()).then(d=>{document.getElementById(\'st\').textContent=d.runner.enabled?\'运行中\':\'已停止\';\n  const tb=document.querySelector(\'#t tbody\');tb.innerHTML=(d.bot.trades||[]).slice().reverse().slice(0,30).map(x=>`<tr><td>${x.t}</td><td class="${x.side==\'UP\'?\'up\':\'dn\'}">${x.side}</td><td>$${x.usd}</td><td>${x.tech}</td><td>${x.price}</td></tr>`).join(\'\')});\n fetch(\'/api/twap\').then(r=>r.json()).then(s=>{if(!s||!s.ts)return;\n  document.getElementById(\'dev\').textContent=(s.dev>0?\'+\':\'\')+s.dev+\'%\';document.getElementById(\'dev\').className=\'big \'+(s.dev>0?\'up\':\'dn\');\n  document.getElementById(\'slug\').textContent=s.round&&s.round.slug||\'-\';document.getElementById(\'rem\').textContent=s.remain??\'-\';\n  document.getElementById(\'base\').textContent=s.base;document.getElementById(\'last\').textContent=s.last;\n  document.getElementById(\'sig\').textContent=s.signal;document.getElementById(\'ask\').textContent=(s.round&&s.round.ask)||\'-\';});\n}\nsetInterval(ref,2500);ref();\n</script></body></html>'
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def j(self,c,o):
        b=json.dumps(o,ensure_ascii=False).encode(); self.send_response(c)
        self.send_header("Content-Type","application/json;charset=utf-8"); self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        p=self.path.split("?")[0]
        if p=="/api/state": return self.j(200,{"runner":rd("runner.json",{"enabled":False}),"bot":rd("bot_state.json",{"trades":[]})})
        if p=="/api/stats": return self.j(200, rd("stats.json",{}))
        if p=="/api/twap": return self.j(200,rd("twap_state.json",{}))
        if p=="/api/start": wr("runner.json",{"enabled":True}); return self.j(200,{"enabled":True})
        if p=="/api/stop": wr("runner.json",{"enabled":False}); return self.j(200,{"enabled":False})
        b=PAGE.encode(); self.send_response(200); self.send_header("Content-Type","text/html;charset=utf-8")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
with socketserver.ThreadingTCPServer(("",8090),H) as s: s.serve_forever()
