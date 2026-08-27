#!/usr/bin/env python3
"""趋势策略单独回测: 只在趋势市顺势交易 (涨市破前高做多 / 跌市破前低做空)
不混入布林/震荡. 严格模拟trend-band趋势波段:
  开仓: 4h EMA7>25>99多头排列+破60前高做多 / EMA7<25<99空头+破60前低做空
  出场: 止损0.8ATR / 止盈2ATR / 两阶段锁利(浮盈2%后回撤1%平)
  市场过滤: 只在趋势市(ADX>=20)交易, 震荡市/剧烈波动观望
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

def trend_signal(c,i):
    """趋势波段开仓: EMA排列+破60前高/前低"""
    if i<100: return 'NONE'
    e7=ema_at(c,i,7);e25=ema_at(c,i,25);e99=ema_at(c,i,99);e50=ema_at(c,i,50)
    if None in (e7,e25,e99,e50): return 'NONE'
    price=c[i]; mom=(price-e50)/(e50 or 1)
    if e7>e25 and e25>e99:
        if price>max(c[max(0,i-60):i]) and mom>0.01: return 'LONG'
    elif e7<e25 and e25<e99:
        if price<min(c[max(0,i-60):i]) and mom<-0.01: return 'SHORT'
    return 'NONE'

def backtest(kl):
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]
    n=len(c); trades=[]; pos=None; i=120
    while i<n-1:
        price=c[i]; atr=atr_at(h,l,c,i) or 0.0001
        adx=adx_at(h,l,c,i)
        # 持仓管理
        if pos:
            pnl=(price-pos['e'])/pos['e'] if pos['side']=='L' else (pos['e']-price)/pos['e']
            best=pos.get('best',pos['e'])
            if pos['side']=='L':
                if price>best: pos['best']=price
                # 止损0.8ATR
                if price<=pos['e']-0.8*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                # 锁利: 浮盈2%后回撤1%
                if pnl>=0.02 and price<=best*(1-0.01): trades.append(pnl-2*FEE); pos=None; i+=1; continue
                # 止盈2ATR
                if price>=pos['e']+2*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
            else:
                if price<best: pos['best']=price
                if price>=pos['e']+0.8*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pnl>=0.02 and price>=best*(1+0.01): trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if price<=pos['e']-2*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
            i+=1; continue
        # 只在趋势市(ADX>=20)开仓
        if adx<20: i+=1; continue
        sig=trend_signal(c,i)
        if sig=='LONG': pos={'side':'L','e':price,'best':price}; i+=1; continue
        elif sig=='SHORT': pos={'side':'S','e':price,'best':price}; i+=1; continue
        i+=1
    if not trades: return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(trades)
    for t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),'ret':round(gross*100,2),'maxdd':round(md*100,2)}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT']
P4=72

def main():
    print('═══ 趋势策略单独回测 (趋势市顺势: 涨做多/跌做空) ═══',flush=True)
    print('═══ 8币 4h | 费0.1% | 止损0.8ATR/止盈2ATR/锁利2%回1% | 仅趋势市(ADX>=20) ═══\n',flush=True)
    agg={'t':0,'w':0,'ret':0.0,'md':0.0}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)<600: print(f'  {sym}: 数据不足({len(kl)})'); continue
            r=backtest(kl)
            print(f"  {sym:<10} {r['t']:4}笔 胜{r['wr']:4.1f}% 回报{r['ret']:+7.1f}% 回撤{r['maxdd']:5.1f}%",flush=True)
            agg['t']+=r['t'];agg['w']+=r['w'];agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        except Exception as e: print(f'  {sym}: {e}',flush=True)
    wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
    print('',flush=True)
    print(f"═══ 汇总(8币12月): {agg['t']}笔 胜率{wr}% 累加回报{agg['ret']:+.1f}% 最大回撤{agg['md']:.1f}% ═══",flush=True)

main()
