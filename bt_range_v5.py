#!/usr/bin/env python3
"""震荡策略回测 v5 — 多方案对比 (布林均值回归 + RSI + SUPER + ADX 过滤)
目标: 在震荡市(ADX低/带宽窄)做均值回归, 快进快出, 严格止损
"""
import urllib.request, json, time, math

UA = {'User-Agent': 'Mozilla/5.0'}
FEE = 0.0005

def get_k(sym, iv, pages=8):
    data = []; et = ''
    for _ in range(pages):
        url = f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et: url += f'&endTime={et}'
        try:
            b = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15).read().decode())
        except Exception:
            time.sleep(0.3); continue
        if not b: break
        data = b + data; et = str(b[0][0]); time.sleep(0.05)
    data.sort(key=lambda x: x[0])
    return [{'t': int(x[0]), 'open': float(x[1]), 'high': float(x[2]), 'low': float(x[3]), 'close': float(x[4]), 'volume': float(x[5])} for x in data]

def ema(vals, p):
    if len(vals) < p: return None
    k = 2/(p+1); e = vals[0]
    for v in vals[1:]: e = v*k + e*(1-k)
    return e

def rsi(cl, n=14):
    if len(cl) <= n: return None
    g = l = 0.0
    for i in range(len(cl)-n, len(cl)):
        d = cl[i]-cl[i-1]
        if d >= 0: g += d
        else: l -= d
    if l == 0: return 100
    return 100 - 100/(1 + (g/n)/(l/n))

def atr_calc(kl, p=14):
    n = len(kl); out = [0.0]*n
    for i in range(n):
        if i == 0: out[i] = kl[i]['high']-kl[i]['low']; continue
        tr = max(kl[i]['high']-kl[i]['low'], abs(kl[i]['high']-kl[i-1]['close']), abs(kl[i]['low']-kl[i-1]['close']))
        out[i] = tr if i < p else (out[i-1]*(p-1)+tr)/p
    return out

def adx_calc(kl, p=14):
    n = len(kl)
    if n < p+2: return [None]*n
    plus=[0.0]*n; minus=[0.0]*n; tr=[0.0]*n
    for i in range(1,n):
        up = kl[i]['high']-kl[i-1]['high']; dn = kl[i-1]['low']-kl[i]['low']
        plus[i] = up if (up>dn and up>0) else 0.0
        minus[i] = dn if (dn>up and dn>0) else 0.0
        tr[i] = max(kl[i]['high']-kl[i]['low'], abs(kl[i]['high']-kl[i-1]['close']), abs(kl[i]['low']-kl[i-1]['close']))
    out=[None]*n; pdm=mdm=atr=0.0
    for i in range(1,n):
        if i<=p:
            pdm+=plus[i]; mdm+=minus[i]; atr+=tr[i]
            if i==p:
                pdi=100*pdm/atr if atr else 0; mdi=100*mdm/atr if atr else 0
                out[i]=100*abs(pdi-mdi)/max(pdi+mdi,1e-9)
        else:
            pdm=pdm-pdm/p+plus[i]; mdm=mdm-mdm/p+minus[i]; atr=atr-atr/p+tr[i]
            pdi=100*pdm/atr if atr else 0; mdi=100*mdm/atr if atr else 0
            dx=100*abs(pdi-mdi)/max(pdi+mdi,1e-9)
            out[i]=out[i-1]+(dx-out[i-1])/p if out[i-1] is not None else dx
    return out

def bw_series(cl, p=20, k=2.0):
    out=[None]*len(cl)
    for i in range(len(cl)):
        if i < p: continue
        seg=cl[i-p+1:i+1]; m=sum(seg)/p
        sd=math.sqrt(sum((x-m)**2 for x in seg)/p) or 1e-9
        out[i]=(2*k*sd)/m*100
    return out

def bb(cl, p=20, k=2.0):
    if len(cl) < p: return None
    seg=cl[-p:]; m=sum(seg)/p
    sd=math.sqrt(sum((x-m)**2 for x in seg)/p) or 1e-9
    return {'mid':m,'upper':m+k*sd,'lower':m-k*sd,'bw':(2*k*sd)/m*100}

def supertrend(kl, period=10, mult=3.0):
    n=len(kl); hl2=[(k['high']+k['low'])/2 for k in kl]; atr=atr_calc(kl,period)
    up=[0.0]*n; dn=[0.0]*n; dr=[1]*n
    for i in range(n):
        u=hl2[i]+mult*atr[i]; d=hl2[i]-mult*atr[i]
        if i>0:
            u=u if (u<up[i-1] or kl[i-1]['close']>up[i-1]) else up[i-1]
            d=d if (d>dn[i-1] or kl[i-1]['close']<dn[i-1]) else dn[i-1]
        up[i]=u; dn[i]=d
        if i==0: dr[i]=1
        elif kl[i]['close']>up[i-1]: dr[i]=1
        elif kl[i]['close']<dn[i-1]: dr[i]=-1
        else: dr[i]=(1 if kl[i]['close']>=dn[i] else -1) if dr[i-1]==1 else (-1 if kl[i]['close']<=up[i] else 1)
    return dr

def bt(sym, kl, cfg):
    cl=[k['close'] for k in kl]; n=len(kl)
    atrs=atr_calc(kl,14); adxs=adx_calc(kl,14); bws=bw_series(cl); drs=supertrend(kl)
    pos=None; trades=[]; win=loss=0; psum=0.0
    lev=cfg.get('lev',3)
    for i in range(60,n-1):
        price=cl[i]; bbv=bb(cl[:i+1])
        if not bbv: continue
        # 出场
        if pos:
            ep=pos['entry']
            pct=((price-ep)/ep*100) if pos['side']=='LONG' else ((ep-price)/ep*100)
            roi=pct*lev; why=None
            if pct>=cfg['tp']: why='TP'
            elif atrs[i] and abs(price-ep)>=cfg['slatr']*atrs[i]: why='ATR'
            elif roi<=-cfg['maxloss']: why='MAX'
            elif i-pos['i']>=cfg['maxbars']: why='TIME'
            if why:
                net=roi-FEE*lev*2*100
                trades.append(net); psum+=net
                if net>0: win+=1
                else: loss+=1
                pos=None
        if pos: continue
        # 震荡过滤: ADX必须低(震荡市)
        if adxs[i] is None or adxs[i] > cfg['maxadx']: continue
        if bws[i] is None or bws[i] > cfg['maxbw']: continue
        # 带宽分位(近100)
        hist=[x for x in bws[max(0,i-100):i] if x is not None]
        if hist:
            pctl=sum(1 for x in hist if x<bws[i])/len(hist)*100
            if pctl > cfg['maxbwpctl']: continue
        r=rsi(cl[:i+1],14)
        touchedL=price<=bbv['lower']; touchedU=price>=bbv['upper']
        if cfg['use_super']:
            if (touchedL or price<=bbv['mid']-(bbv['mid']-bbv['lower'])*0.5) and rsi(cl[:i+1],14)<cfg['rsi_lo'] and drs[i]==1:
                pos={'side':'LONG','entry':price,'i':i}
            elif (touchedU or price>=bbv['mid']+(bbv['upper']-bbv['mid'])*0.5) and rsi(cl[:i+1],14)>cfg['rsi_hi'] and drs[i]==-1:
                pos={'side':'SHORT','entry':price,'i':i}
        else:
            if (touchedL) and rsi(cl[:i+1],14)<cfg['rsi_lo']:
                pos={'side':'LONG','entry':price,'i':i}
            elif (touchedU) and rsi(cl[:i+1],14)>cfg['rsi_hi']:
                pos={'side':'SHORT','entry':price,'i':i}
    tot=win+loss; wr=round(win/tot*100,1) if tot else 0
    return tot,wr,round(psum,1)

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','SUIUSDT','LINKUSDT','AVAXUSDT','ADAUSDT','NEARUSDT','APTUSDT','LTCUSDT','DOTUSDT','UNIUSDT']

CFGS=[
 dict(name='A: 5m 紧震荡(ADX<25,BW<3%,RSI30/70,SUPER)', iv='5m', maxadx=25, maxbw=3.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68, tp=1.5, slatr=2.0, maxloss=5, maxbars=30, lev=3, use_super=True),
 dict(name='B: 15m 震荡(ADX<25,BW<5%,RSI30/70,SUPER)', iv='15m', maxadx=25, maxbw=5.0, maxbwpctl=70, rsi_lo=30, rsi_hi=70, tp=2.0, slatr=2.0, maxloss=6, maxbars=40, lev=3, use_super=True),
 dict(name='C: 15m 纯均值回归(不用SUPER)', iv='15m', maxadx=25, maxbw=5.0, maxbwpctl=70, rsi_lo=30, rsi_hi=70, tp=2.0, slatr=2.0, maxloss=6, maxbars=40, lev=3, use_super=False),
 dict(name='D: 1h 震荡(ADX<20,BW<4%)', iv='1h', maxadx=20, maxbw=4.0, maxbwpctl=60, rsi_lo=30, rsi_hi=70, tp=2.0, slatr=2.0, maxloss=6, maxbars=30, lev=3, use_super=True),
]
import sys
for cfg in CFGS:
    print(f"\n═══ {cfg['name']} ({cfg['iv']}) ═══")
    tt=tw=tr=0
    for s in SYMS:
        kl=get_k(s,cfg['iv'],6)
        if len(kl)<120: continue
        t,wr,r=bt(s,kl,cfg)
        tt+=t; tr+=r; tw+=round(t*wr/100)
        print(f"  {s:11s} {t:3d}笔 胜{wr:5.1f}% 回报{r:+8.1f}% {'🟢' if r>0 else '🔴'}")
    wr=round(tw/tt*100,1) if tt else 0
    print(f"  ══ 汇总: {tt}笔 胜率{wr}% 总回报{tr:+.1f}%")
