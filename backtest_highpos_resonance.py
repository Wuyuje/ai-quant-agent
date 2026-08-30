#!/usr/bin/env python3
"""高仓位 + 高低点共振过滤 回测 (不用降仓位, 用择时防护)
理念(用户): 好趋势重仓赚大钱, 风控靠"高位不追高/低位不追低"(共振识别), 而非降仓位
固定高仓位(每仓15%), 对比共振过滤强度: 无/轻(N≥1)/中(N≥2)/重(N≥3)
看真实复利回报 + 回撤(重点: 高位不追高能否防住风险)
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
    e12=ema_at(c,i,12); e26=ema_at(c,i,26)
    if e12 is None or e26 is None: return None
    return e12-e26

def vol_ratio(v,i):
    if i<25: return 1
    now=sum(v[i-5:i])/5; prev=sum(v[i-25:i-5])/20
    return now/prev if prev>0 else 1

def high_low_resonance(c,h,l,v,i):
    """返回(高点共振数, 低点共振数) - 分别几个指标判定"""
    rsi=rsi_at(c,i,14)
    lo_=min(c[max(0,i-60):i]); hi_=max(c[max(0,i-60):i])
    pos60=(c[i]-lo_)/((hi_-lo_) or 1)*100
    macd=macd_at(c,i); volr=vol_ratio(v,i)
    hi_res=0; lo_res=0
    # 高点指标
    if rsi>75: hi_res+=1
    if pos60>90: hi_res+=1
    seg=c[max(0,i-60):i]
    if seg:
        hi_idx=seg.index(max(seg)); abs_hi=max(0,i-60)+hi_idx
        if macd is not None and i>abs_hi and macd_at(c,abs_hi) is not None and macd<macd_at(c,abs_hi): hi_res+=1
    if pos60>70 and volr<1: hi_res+=1
    # 低点指标
    if rsi<25: lo_res+=1
    if pos60<10: lo_res+=1
    if seg:
        lo_idx=seg.index(min(seg)); abs_lo=max(0,i-60)+lo_idx
        if macd is not None and i>abs_lo and macd_at(c,abs_lo) is not None and macd>macd_at(c,abs_lo): lo_res+=1
    if pos60<30 and volr<1: lo_res+=1
    return hi_res, lo_res

def backtest(kl, N, pos_pct=0.15, lev=3):
    """N: 共振过滤强度. 固定高仓位pos_pct. 真实复利"""
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]; v=[x[5] for x in kl]
    n=len(c); i=140; equity=1.0; peak=1.0; maxdd=0; nw=0; nt=0; pos=None
    while i<n-1:
        price=c[i]; atr=atr_at(h,l,c,i) or 0.0001
        if pos:
            pnl_pct=(price-pos['e'])/pos['e'] if pos['side']=='L' else (pos['e']-price)/pos['e']
            trade_pnl=pnl_pct*lev*pos_pct
            best=pos.get('best',pos['e'])
            if pos['side']=='L':
                if price>best: pos['best']=price
                closed=False
                if price<=pos['e']-0.8*atr: closed=True
                elif pos.get('lock') and price<=best*(1-0.01): closed=True
                elif pnl_pct>=0.02: pos['lock']=True
                if price>=pos['e']+2*atr: closed=True
                if closed:
                    equity*=(1+trade_pnl); nt+=1
                    if trade_pnl>0: nw+=1
                    if equity>peak: peak=equity
                    dd=(peak-equity)/peak; maxdd=max(maxdd,dd)
                    pos=None; i+=1; continue
            else:
                if price<best: pos['best']=price
                closed=False
                if price>=pos['e']+0.8*atr: closed=True
                elif pos.get('lock') and price>=best*(1+0.01): closed=True
                elif pnl_pct>=0.02: pos['lock']=True
                if price<=pos['e']-2*atr: closed=True
                if closed:
                    equity*=(1+trade_pnl); nt+=1
                    if trade_pnl>0: nw+=1
                    if equity>peak: peak=equity
                    dd=(peak-equity)/peak; maxdd=max(maxdd,dd)
                    pos=None; i+=1; continue
            i+=1; continue
        if adx_at(h,l,c,i)<20: i+=1; continue
        if i<120: i+=1; continue
        e7=ema_at(c,i,7);e25=ema_at(c,i,25);e99=ema_at(c,i,99);e50=ema_at(c,i,50)
        if None in (e7,e25,e99,e50): i+=1; continue
        mom=(price-e50)/(e50 or 1)
        hi_=max(c[max(0,i-60):i]); lo_=min(c[max(0,i-60):i])
        hi_res,lo_res=high_low_resonance(c,h,l,v,i)
        blocked_h=hi_res>=N; blocked_l=lo_res>=N
        # 开多: 顺势 + 高位不追高(N)
        if e7>e25 and e25>e99 and price>hi_ and mom>0.01 and not blocked_h:
            pos={'side':'L','e':price,'best':price}; i+=1; continue
        if e7<e25 and e25<e99 and price<lo_ and mom<-0.01 and not blocked_l:
            pos={'side':'S','e':price,'best':price}; i+=1; continue
        i+=1
    if nt==0: return {'t':0,'wr':0,'ret':0.0,'maxdd':0.0}
    return {'t':nt,'wr':round(nw*100/nt,1),'ret':round((equity-1)*100,1),'maxdd':round(maxdd*100,1)}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT']
P4=72
GRID=[('高仓15%无过滤',0),('高仓15%共振≥1',1),('高仓15%共振≥2',2),('高仓15%共振≥3',3)]

def main():
    print('═══ 高仓位(15%) + 高低点共振过滤 回测 (不降仓位,择时防护) ═══',flush=True)
    print('═══ 8币4h | 每仓15%本金杠杆3x | 真实复利 ═══\n',flush=True)
    bars={}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)>600: bars[sym]=kl
        except: pass
    print(f'载入{len(bars)}币\n',flush=True)
    for label,N in GRID:
        rets=[];mds=[];ts=0;ws=0
        for sym,kl in bars.items():
            r=backtest(kl,N)
            rets.append(r['ret']);mds.append(r['maxdd']);ts+=r['t'];ws+=int(r['wr']*r['t']/100)
        avg_ret=sum(rets)/len(rets); wr=round(ws*100/ts,1) if ts else 0
        print(f"  {label:<16} 均回报{avg_ret:+6.1f}% (最好{max(rets):+.0f}/最差{min(rets):+.0f}) 胜率{wr}% 最大回撤{max(mds):.1f}% | {ts}笔",flush=True)

main()
