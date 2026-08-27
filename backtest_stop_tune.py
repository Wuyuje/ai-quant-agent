#!/usr/bin/env python3
"""止损参数调优回测: 在仓位不变前提下, 对比不同止损/止盈/锁利参数, 找回撤可控+正回报组合
仅调整止损相关参数, 不做仓位变化
"""
import urllib.request,json,time,math,sys
UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005

def get_k(sym,iv,pages):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et:url+=f'&endTime={et}'
        req=urllib.request.Request(url,headers=UA)
        ok=False
        for a in range(3):
            try:
                b=json.loads(urllib.request.urlopen(req,timeout=15).read().decode());ok=True;break
            except: time.sleep(0.3)
        if not ok:break
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.04)
    data.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def ema_at(c,i,p):
    if i<p: return None
    k=2/(p+1); e=c[i-p+1]
    for x in range(i-p+2,i+1): e=c[x]*k+e*(1-k)
    return e

def atr_at(h,l,c,i,n=14):
    if i<n: return 0
    trs=[]
    for j in range(i-n,i+1):
        trs.append(max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])))
    return sum(trs)/len(trs)

def adx_at(h,l,c,i,n=14):
    if i<n*2: return 0
    pdi=ndi=tr=0
    for j in range(i-n+1,i+1):
        up=h[j]-h[j-1]; dn=l[j-1]-l[j]
        pdi+=up if up>dn and up>0 else 0
        ndi+=dn if dn>up and dn>0 else 0
        tr+=max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1]))
    if tr==0: return 0
    pd=100*pdi/tr; nd=100*ndi/tr
    return abs(pd-nd)/(pd+nd)*100 if (pd+nd)>0 else 0

def calc_bands(c,i,p=20,sd=2):
    seg=c[i-p:i]; mid=sum(seg)/p
    var=sum((x-mid)**2 for x in seg)/p; sdv=math.sqrt(var)
    return mid+sd*sdv, mid, mid-sd*sdv

def market_state(c,h,l,i):
    e7=ema_at(c,i,7); e25=ema_at(c,i,25)
    adx=adx_at(h,l,c,i)
    if adx<20:
        up,mid,lo=calc_bands(c,i)
        if (up-lo)/(mid or 1)>0.08: return 'SHOCK','FLAT'
        return 'OSC','FLAT'
    if None in (e7,e25): return 'OSC','FLAT'
    return ('TREND','UP') if e7>e25 else ('TREND','DOWN')

def backtest(kl,cfg):
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]
    n=len(c); trades=[]; pos=None; i=100
    t_stop=cfg['t_stop']; t_tp=cfg['t_tp']; t_lock=cfg['t_lock']; t_trail=cfg['t_trail']
    o_stop=cfg['o_stop']
    while i<n-1:
        price=c[i]; atr=atr_at(h,l,c,i) or 0.0001
        up,mid,lo=calc_bands(c,i)
        if pos:
            pnl=(price-pos['e'])/pos['e'] if pos['side']=='L' else (pos['e']-price)/pos['e']
            if pos['strat']=='trend':
                if pos['side']=='L' and price<=pos['e']-t_stop*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pos['side']=='S' and price>=pos['e']+t_stop*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pnl>=t_lock:
                    best=pos.get('best',pos['e'])
                    if pos['side']=='L':
                        if price>best: pos['best']=price
                        if price<=best*(1-t_trail): trades.append(pnl-2*FEE); pos=None; i+=1; continue
                    else:
                        if price<best: pos['best']=price
                        if price>=best*(1+t_trail): trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pos['side']=='L' and price>=pos['e']+t_tp*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pos['side']=='S' and price<=pos['e']-t_tp*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
            else:
                if pnl<=-o_stop: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pos['side']=='L' and price>=mid and pnl>0: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pos['side']=='S' and price<=mid and pnl>0: trades.append(pnl-2*FEE); pos=None; i+=1; continue
            i+=1; continue
        st,dir_=market_state(c,h,l,i)
        if st=='SHOCK': i+=1; continue
        if st=='TREND':
            hi=max(c[max(0,i-60):i]); lo_=min(c[max(0,i-60):i])
            if dir_=='UP' and price>hi: pos={'side':'L','e':price,'strat':'trend'}; i+=1; continue
            if dir_=='DOWN' and price<lo_: pos={'side':'S','e':price,'strat':'trend'}; i+=1; continue
        else:
            if price<=lo: pos={'side':'L','e':price,'strat':'osc'}; i+=1; continue
            if price>=up: pos={'side':'S','e':price,'strat':'osc'}; i+=1; continue
        i+=1
    if not trades: return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(trades)
    for t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),'ret':round(gross*100,2),'maxdd':round(md*100,2)}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT']
P4=72
# 止损参数网格(仓位不变)
CFGS=[
  ('当前(止损0.8/止盈2/锁2%回1%)',{'t_stop':0.8,'t_tp':2.0,'t_lock':0.02,'t_trail':0.01,'o_stop':0.02}),
  ('更紧止损(0.5/2/2%/1%)',{'t_stop':0.5,'t_tp':2.0,'t_lock':0.02,'t_trail':0.01,'o_stop':0.015}),
  ('较宽止损(1.2/2/2%/1%)',{'t_stop':1.2,'t_tp':2.0,'t_lock':0.02,'t_trail':0.01,'o_stop':0.03}),
  ('宽止损高止盈(1.2/3/3%/1.2%)',{'t_stop':1.2,'t_tp':3.0,'t_lock':0.03,'t_trail':0.012,'o_stop':0.03}),
  ('紧锁利(0.8/2/1.5%/0.8%)',{'t_stop':0.8,'t_tp':2.0,'t_lock':0.015,'t_trail':0.008,'o_stop':0.02}),
]

def main():
    print('═══ 止损参数调优回测(仓位不变) ═══',flush=True)
    print('═══ 7币 4h | 费0.1% ═══\n',flush=True)
    bars={}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)>600: bars[sym]=kl
        except: pass
    print(f'载入 {len(bars)}币\n',flush=True)
    for name,cfg in CFGS:
        agg={'t':0,'w':0,'ret':0.0,'md':0.0}
        for sym,kl in bars.items():
            r=backtest(kl,cfg)
            agg['t']+=r['t'];agg['w']+=r['w'];agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
        print(f"  {name:<24} {agg['t']:4}笔 胜{wr:4.1f}% 回报{agg['ret']:+7.1f}% 回撤{agg['md']:5.1f}%",flush=True)

main()
