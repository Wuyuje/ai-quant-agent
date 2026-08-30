#!/usr/bin/env python3
"""多指标共振识别相对高点/低点, 回测过滤追高/追低
识别"相对高点"(不追多)的共振指标:
  1. RSI(14)>rsi_hi (超买)
  2. 价格在近60根位置>pos_hi (%) (相对高位)
  3. MACD顶背离 (价新高但动能未新高)
  4. 量价背离 (高位位置>qpos 且 量比<qvol 缩量)
开多前, 若满足 num>=N 个共振指标 → 不追多 (N=共振强度)
开空对称(相对低点): RSI<rsi_lo / 位置<pos_lo / MACD底背离 / 低位缩量
对比: 原版 vs 各种共振强度(N=1/2/3)
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
        data=b+data;et=str(b[0][0]);time.sleep(0.02)
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

def rsi_at(c,i,n=14):
    if i<n+1: return 50
    gains=losses=0
    for j in range(i-n+1,i+1):
        d=c[j]-c[j-1]
        if d>0: gains+=d
        else: losses-=d
    if gains+losses==0: return 50
    rs=gains/losses if losses>0 else 99
    return 100-100/(1+rs)

def macd_at(c,i):
    """返回MACD(DIF): EMA12-EMA26, 用于背离判断(简化用短线动能)"""
    e12=ema_at(c,i,12); e26=ema_at(c,i,26)
    if e12 is None or e26 is None: return None
    return e12-e26

def vol_ratio(v,i):
    if i<25: return 1
    now=sum(v[i-5:i])/5; prev=sum(v[i-25:i-5])/20
    return now/prev if prev>0 else 1

def backtest(kl, N, forever):
    """N: 共振强度(几个指标满足才拦). 指标: RSI/位置/MACD背离/量价背离
    forever: 是否做空也对称识别低点"""
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]; v=[x[5] for x in kl]
    n=len(c); trades=[]; pos=None; i=140
    while i<n-1:
        price=c[i]; atr=atr_at(h,l,c,i) or 0.0001
        if pos:
            pnl=(price-pos['e'])/pos['e'] if pos['side']=='L' else (pos['e']-price)/pos['e']
            best=pos.get('best',pos['e'])
            if pos['side']=='L':
                if price>best: pos['best']=price
                if price<=pos['e']-0.8*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pnl>=0.02 and price<=best*(1-0.01): trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if price>=pos['e']+2*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
            else:
                if price<best: pos['best']=price
                if price>=pos['e']+0.8*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pnl>=0.02 and price>=best*(1+0.01): trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if price<=pos['e']-2*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
            i+=1; continue
        if adx_at(h,l,c,i)<20: i+=1; continue  # 只在趋势市
        if i<120: i+=1; continue
        e7=ema_at(c,i,7);e25=ema_at(c,i,25);e99=ema_at(c,i,99);e50=ema_at(c,i,50)
        if None in (e7,e25,e99,e50): i+=1; continue
        mom=(price-e50)/(e50 or 1)
        hi_=max(c[max(0,i-60):i]); lo_=min(c[max(0,i-60):i])
        # 共振指标
        rsi=rsi_at(c,i,14)
        pos60=(price-min(c[max(0,i-60):i]))/((max(c[max(0,i-60):i])-min(c[max(0,i-60):i])) or 1)*100
        macd=macd_at(c,i)
        volr=vol_ratio(v,i)
        # 高点共振(拦截追多): RSI高 / 位置高 / MACD顶背离(价新高但macd未新) / 高位缩量
        hi_res=[]
        if rsi>75: hi_res.append('rsi')
        if pos60>90: hi_res.append('pos')
        # MACD顶背离: 当前价创新高但macd比前高macd低(简化: 最近60根高点时macd比较)
        hi_idx=c[max(0,i-60):i].index(max(c[max(0,i-60):i])) if i>=60 else 0
        abs_hi_idx=max(0,i-60)+hi_idx
        if macd is not None and i>abs_hi_idx and c[abs_hi_idx]>price*0.98 and macd_at(c,abs_hi_idx) is not None and macd<macd_at(c,abs_hi_idx): hi_res.append('div')
        # 高位缩量(量价背离)
        if pos60>70 and volr<1: hi_res.append('vol')
        hit_hi=len(hi_res)>=N
        # 低点共振(拦截追空)
        lo_res=[]
        if forever:
            if rsi<25: lo_res.append('rsi')
            if pos60<10: lo_res.append('pos')
            lo_idx=c[max(0,i-60):i].index(min(c[max(0,i-60):i])) if i>=60 else 0
            abs_lo_idx=max(0,i-60)+lo_idx
            if macd is not None and i>abs_lo_idx and c[abs_lo_idx]<price*1.02 and macd_at(c,abs_lo_idx) is not None and macd>macd_at(c,abs_lo_idx): lo_res.append('div')
            if pos60<30 and volr<1: lo_res.append('vol')
        hit_lo=len(lo_res)>=N if forever else False
        # 开多: 顺势 + 非高点共振
        if e7>e25 and e25>e99 and price>hi_ and mom>0.01 and not hit_hi:
            pos={'side':'L','e':price,'best':price}; i+=1; continue
        if e7<e25 and e25<e99 and price<lo_ and mom<-0.01 and not hit_lo:
            pos={'side':'S','e':price,'best':price}; i+=1; continue
        i+=1
    if not trades: return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(trades)
    for t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),'ret':round(gross*100,2),'maxdd':round(md*100,2)}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT']
P4=72
# 共振强度: 原版(N=9=永拦)/单指标(N=1)/双指标(N=2)/三指标(N=3), 以及开空对称与否
GRID=[
  ('原版(无共振)', 9, False),
  ('共振N≥1', 1, False),
  ('共振N≥2', 2, False),
  ('共振N≥3', 3, False),
  ('共振N≥1+对称做空', 1, True),
  ('共振N≥2+对称做空', 2, True),
]

def main():
    print('═══ 多指标共振识别相对高点/低点 回测 ═══',flush=True)
    print('═══ 8币4h | RSI+位置+MACD背离+量价背离 共振 ═══\n',flush=True)
    bars={}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)>600: bars[sym]=kl
        except: pass
    print(f'载入{len(bars)}币\n',flush=True)
    for label,n,fe in GRID:
        agg={'t':0,'w':0,'ret':0.0,'md':0.0}
        for sym,kl in bars.items():
            r=backtest(kl,n,fe)
            agg['t']+=r['t'];agg['w']+=r['w'];agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
        print(f"  {label:<18} {agg['t']:4}笔 胜{wr:4.1f}% 回报{agg['ret']:+7.1f}% 回撤{agg['md']:5.1f}%",flush=True)

main()
