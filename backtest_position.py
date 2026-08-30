#!/usr/bin/env python3
"""共振过滤+对称做空+适度仓位 回测: 看真实复利回报率/胜率/回撤
对比3种仓位(每仓%本金): 20%高仓 / 10%中仓 / 5%低仓, 全部加共振过滤(识高低点)+对称做空
关键: 用真实复利净值计算回报率(不是累加%), 回撤用净值曲线
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

def backtest(kl, pos_pct, lev=3):
    """pos_pct: 每仓占本金比例(如0.10=10%). 共振过滤N≥2+对称做空. 返回真实复利回报/胜率/回撤"""
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]; v=[x[5] for x in kl]
    n=len(c); i=140; equity=1.0; peak=1.0; maxdd=0; num_wins=0; num_trades=0
    pos=None
    while i<n-1:
        price=c[i]; atr=atr_at(h,l,c,i) or 0.0001
        if pos:
            # 该仓损益(按本金%) = 价格变动% × 杠杆 × 仓位占比
            pnl_pct=(price-pos['e'])/pos['e'] if pos['side']=='L' else (pos['e']-price)/pos['e']
            # 用真实本金影响: 每仓占pos_pct本金, 杠杆lev
            trade_pnl = pnl_pct*lev*pos_pct   # 对equity的影响(复利)
            best=pos.get('best',pos['e'])
            if pos['side']=='L':
                if price>best: pos['best']=price
                closed=False
                if price<=pos['e']-0.8*atr: closed=True
                elif pos.get('lock') and price<=best*(1-0.01): closed=True
                elif pnl_pct>=0.02: pos['lock']=True; closed=False
                if price>=pos['e']+2*atr: closed=True
                if closed:
                    equity*=(1+trade_pnl); num_trades+=1
                    if trade_pnl>0: num_wins+=1
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
                    equity*=(1+trade_pnl); num_trades+=1
                    if trade_pnl>0: num_wins+=1
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
        rsi=rsi_at(c,i,14)
        pos60=(price-lo_)/((hi_-lo_) or 1)*100
        macd=macd_at(c,i); volr=vol_ratio(v,i)
        # 高点共振(N≥2)
        hi_res=[]
        if rsi>75: hi_res.append(1)
        if pos60>90: hi_res.append(1)
        hi_idx=0; amax=c[max(0,i-60):i]
        if amax: hi_idx=amax.index(max(amax))
        abs_hi=max(0,i-60)+hi_idx
        if macd is not None and i>abs_hi and macd_at(c,abs_hi) is not None and macd<macd_at(c,abs_hi): hi_res.append(1)
        if pos60>70 and volr<1: hi_res.append(1)
        hit_hi=len(hi_res)>=2
        # 低点共振(N≥2)
        lo_res=[]
        if rsi<25: lo_res.append(1)
        if pos60<10: lo_res.append(1)
        if amax: lo_idx=amax.index(min(amax))
        abs_lo=max(0,i-60)+lo_idx if amax else i
        if macd is not None and i>abs_lo and macd_at(c,abs_lo) is not None and macd>macd_at(c,abs_lo): lo_res.append(1)
        if pos60<30 and volr<1: lo_res.append(1)
        hit_lo=len(lo_res)>=2
        if e7>e25 and e25>e99 and price>hi_ and mom>0.01 and not hit_hi:
            pos={'side':'L','e':price,'best':price}; i+=1; continue
        if e7<e25 and e25<e99 and price<lo_ and mom<-0.01 and not hit_lo:
            pos={'side':'S','e':price,'best':price}; i+=1; continue
        i+=1
    if num_trades==0: return {'t':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wr=num_wins*100/num_trades
    ret=(equity-1)*100
    return {'t':num_trades,'wr':round(wr,1),'ret':round(ret,1),'maxdd':round(maxdd*100,1)}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT']
P4=72
# 3种仓位对比: 高20% / 中10% / 低5%, 全部加共振N≥2+对称做空
GRID=[('高仓20%+共振',0.20),('中仓10%+共振',0.10),('低仓5%+共振',0.05)]

def main():
    print('═══ 共振过滤+对称做空+仓位对比 (真实复利回报) ═══',flush=True)
    print('═══ 8币4h | 每仓20%/10%/5% 本金 | 杠杆3x ═══\n',flush=True)
    bars={}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)>600: bars[sym]=kl
        except: pass
    print(f'载入{len(bars)}币\n',flush=True)
    for label,pct in GRID:
        # 聚合: 每个币独立复利, 汇总看平均/最差
        rets=[];mds=[];ts=0;ws=0
        for sym,kl in bars.items():
            r=backtest(kl,pct)
            rets.append(r['ret']);mds.append(r['maxdd']);ts+=r['t'];ws+=int(r['wr']*r['t']/100)
        avg_ret=sum(rets)/len(rets); avg_md=max(mds)
        wr=round(ws*100/ts,1) if ts else 0
        print(f"  {label:<16} 均回报{avg_ret:+6.1f}% (最好{max(rets):+.0f}/最差{min(rets):+.0f}) 胜率{wr}% 最大回撤{avg_md:.1f}% | {ts}笔",flush=True)

main()
