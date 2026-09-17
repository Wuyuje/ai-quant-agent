#!/usr/bin/env python3
"""趋势策略(真趋势波段MA7)币池优选 — 真实回测
配置(v11): 4h周期, stopMul=0.8ATR, tpMul=3.0ATR, trailMul=2.0ATR, lockProfit=3%
开仓: EMA(7>25>99) + 突破近60根高低 + 相对EMA50偏移>1%
"""
import json,math,sys,os,urllib.request,time
sys.stdout.reconfigure(line_buffering=True)
UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0008

def get_k(sym,iv,pages=6):
    data=[];et=''
    for _ in range(pages):
        u=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et: u+=f'&endTime={et}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=15).read().decode())
        except Exception:
            time.sleep(0.3); continue
        if not b: break
        data=b+data; et=str(b[0][0]); time.sleep(0.04)
    data.sort(key=lambda x:x[0])
    return [{'t':int(x[0]),'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'v':float(x[5])} for x in data]

def ema_s(v,p):
    out=[None]*len(v)
    if len(v)<p: return out
    k=2/(p+1); e=sum(v[:p])/p; out[p-1]=e
    for i in range(p,len(v)):
        e=v[i]*k+e*(1-k); out[i]=e
    return out

def atr_a(kl,i,n=14):
    if i<n+1: return 0
    trs=[]
    for j in range(i-n,i+1):
        if j<1: continue
        h=kl[j]['h'];l=kl[j]['l'];pc=kl[j-1]['c']
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs) if trs else 0

def bt(kl,opt):
    n=len(kl)
    c=[k['c'] for k in kl]
    e7=ema_s(c,7); e25=ema_s(c,25); e99=ema_s(c,99); e50=ema_s(c,50)
    pos=None;trades=[];pnl=0.0;L=opt['lev'];eq=0;pk=0;dd=0
    for i in range(opt['minBars'],n):
        k=kl[i]; price=k['c']
        at=atr_a(kl,i,14)
        if at<=0: continue
        if pos:
            e=pos['entry'];side=pos['side'];best=pos['_best']
            if side=='LONG':
                if price>best: best=price
                pp=(price-e)/e*100
                if pp>=opt['lockP']: stop=best*(1-opt['lockTrail']/100)
                else:
                    trail=best-opt['trail']*at
                    init=e-opt['stop']*at
                    stop=max(init,trail)
                tp=e+opt['tp']*at
                er=None
                if price<=stop: er='止损/锁利'
                elif price>=tp: er='止盈'
            else:
                if price<best: best=price
                pp=(e-price)/e*100
                if pp>=opt['lockP']: stop=best*(1+opt['lockTrail']/100)
                else:
                    trail=best+opt['trail']*at
                    init=e+opt['stop']*at
                    stop=min(init,trail)
                tp=e-opt['tp']*at
                er=None
                if price>=stop: er='止损/锁利'
                elif price<=tp: er='止盈'
            pos['_best']=best
            if not er and (i-pos['i'])>=opt['maxBars']: er='超时'
            if er:
                p_=pp/100.0 - FEE*L
                pnl+=p_;eq+=p_;pk=max(pk,eq);dd=max(dd,pk-eq)
                trades.append({'pnl':p_});pos=None
            continue
        # 开仓
        if i<opt['minBars']: continue
        if not e7[i] or not e25[i] or not e99[i]: continue
        arr='UP' if (e7[i]>e25[i]>e99[i]) else ('DOWN' if (e7[i]<e25[i]<e99[i]) else 'FLAT')
        if arr=='FLAT': continue
        win=kl[max(0,i-opt['brk']):i]
        if not win: continue
        hi=max(x['h'] for x in win); lo=min(x['l'] for x in win)
        if arr=='UP' and price<=hi: continue
        if arr=='DOWN' and price>=lo: continue
        if not e50[i]: continue
        if abs(price-e50[i])/e50[i] < opt['mom']: continue
        pos={'side':'LONG' if arr=='UP' else 'SHORT','entry':price,'i':i,'_best':price}
    return trades,pnl,dd

SYMS=['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','LTCUSDT',
      'DOTUSDT','UNIUSDT','APEUSDT','FILUSDT','NEARUSDT','ATOMUSDT','INJUSDT','OPUSDT','ARBUSDT','SUIUSDT',
      'TIAUSDT','SEIUSDT','STXUSDT','KASUSDT','APTUSDT','WLDUSDT','ORDIUSDT','1000PEPEUSDT','JUPUSDT',
      'PENDLEUSDT','HYPEUSDT','TAOUSDT','BCHUSDT','ENAUSDT','1000SHIBUSDT','AAVEUSDT','ONDOUSDT','TRUMPUSDT',
      'XLMUSDT','1000BONKUSDT','LITUSDT']
CACHE="/root/b5cache/pool4h.json"
if os.path.exists(CACHE):
    D=json.load(open(CACHE)); print(f"缓存:{len(D)}币",flush=True)
else:
    D={}
    for s in SYMS:
        kl=get_k(s,'4h',pages=6)
        if len(kl)>=500: D[s]=kl
    json.dump(D,open(CACHE,"w"))
n=min(len(v) for v in D.values())
print(f"数据: {len(D)}币 x {n}根4h ({n*4/24:.0f}天≈{n*4/24/365:.1f}年)\n",flush=True)

OPT={'stop':0.8,'tp':3.0,'trail':2.0,'lockP':3.0,'lockTrail':1.2,'lev':5,'brk':60,'mom':0.01,'minBars':200,'maxBars':400}
print(f"{'币种':14s} {'笔数':>5} {'胜率':>6} {'盈亏':>9} {'回撤':>7} {'每单':>9}",flush=True)
res=[]
for s,kl in D.items():
    tr,p,dd=bt(kl,OPT)
    if not tr: continue
    w=sum(1 for t in tr if t['pnl']>0)
    res.append((s,len(tr),100*w/len(tr),p,dd,p/len(tr)))
    time.sleep(0.02)
res.sort(key=lambda x:-x[3])
for s,n_,wr,p,dd,per in res:
    mark=" ✅" if p>0 else " ❌"
    print(f"{s:14s} {n_:5d} {wr:5.1f}% {p:+9.2f} {dd:7.2f} {per:+9.4f}{mark}",flush=True)
print("\n=== 汇总 ===",flush=True)
tot=sum(x[3] for x in res); win=sum(1 for x in res if x[3]>0)
print(f"总盈亏:{tot:+.2f}  盈利币:{win}/{len(res)}",flush=True)
print(f"\n✅ 盈利币池: {[x[0] for x in res if x[3]>0]}",flush=True)
print(f"❌ 亏损币池: {[x[0] for x in res if x[3]<=0]}",flush=True)
