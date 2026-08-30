#!/usr/bin/env python3
"""趋势策略 量价关系过滤回测 (替代固定涨幅%)
核心量价逻辑(用户提出): 涨到高位缩量=涨无可涨(不追多), 跌到低位缩量=跌无可跌(不追空)
对比: 原版(无量价过滤) vs 量价过滤(高位缩量不追多/低位缩量不追空) vs 固定涨幅8%
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
        data=b+data;et=str(b[0][0]);time.sleep(0.03)
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

def vol_ratio(v,i):
    """量比: 近5根均量 / 前20根均量"""
    if i<25: return 1
    now=sum(v[i-5:i])/5; prev=sum(v[i-25:i-5])/20
    return now/prev if prev>0 else 1

def backtest(kl, mode):
    """mode: 'none'原版 / 'gain8'固定涨幅8% / 'volume'量价过滤"""
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]; v=[x[5] for x in kl]
    n=len(c); trades=[]; pos=None; i=120
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
        if adx_at(h,l,c,i)<20: i+=1; continue
        if i<100: i+=1; continue
        e7=ema_at(c,i,7);e25=ema_at(c,i,25);e99=ema_at(c,i,99);e50=ema_at(c,i,50)
        if None in (e7,e25,e99,e50): i+=1; continue
        mom=(price-e50)/(e50 or 1)
        hi=max(c[max(0,i-60):i]); lo=min(c[max(0,i-60):i])
        # 位置和量价
        seg20=c[max(0,i-19):i+1]; hi20=max(seg20); lo20=min(seg20)
        pos20=(price-lo20)/((hi20-lo20) or 1)*100 if hi20!=lo20 else 100
        volr=vol_ratio(v,i)
        gain20=(price-c[max(0,i-20)])/(c[max(0,i-20)] or 1)*100
        # 过滤判断
        blockedL=blockedS=False
        if mode=='none':
            blockedL = (pos20>80 and gain20>20)
        elif mode=='gain8':
            blockedL = (gain20>8) or (pos20>80)
        elif mode=='volume':
            # 量价: 高位缩量(>75%位 + 量比<1)=涨无可涨, 不追多; 低位缩量不追空
            blockedL = (pos20>75 and volr<1)
            blockedS = (pos20<25 and volr<1)
        # 开多
        if e7>e25 and e25>e99 and price>hi and mom>0.01 and not blockedL:
            pos={'side':'L','e':price,'best':price}; i+=1; continue
        # 开空
        if e7<e25 and e25<e99 and price<lo and mom<-0.01 and not blockedS:
            pos={'side':'S','e':price,'best':price}; i+=1; continue
        i+=1
    if not trades: return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(trades)
    for t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),'ret':round(gross*100,2),'maxdd':round(md*100,2)}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT']
P4=72

def main():
    print('═══ 趋势策略 量价过滤回测 (替代固定涨幅%) ═══',flush=True)
    print('═══ 8币4h | 原版 vs 固定涨幅8% vs 量价过滤(高位缩量不追多) ═══\n',flush=True)
    bars={}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)>600: bars[sym]=kl
        except: pass
    print(f'载入{len(bars)}币\n',flush=True)
    for label,mode in [('原版(无过滤)', 'none'), ('固定涨幅8%', 'gain8'), ('量价过滤(高位缩量)', 'volume')]:
        agg={'t':0,'w':0,'ret':0.0,'md':0.0}
        for sym,kl in bars.items():
            r=backtest(kl,mode)
            agg['t']+=r['t'];agg['w']+=r['w'];agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
        print(f"  {label:<18} {agg['t']:4}笔 胜{wr:4.1f}% 回报{agg['ret']:+7.1f}% 回撤{agg['md']:5.1f}%",flush=True)

main()
