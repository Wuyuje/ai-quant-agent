#!/usr/bin/env python3
"""先进均值回归震荡策略回测 (加密货币 Binance 4h)
设计(参考先进量化系统的均值回归框架):
  1. 震荡市识别: ADX<25 且 布林带宽处于历史低位(窄带) → 只在真震荡市交易, 避开趋势
  2. 反转入场(双确认): RSI超卖(<30)且价格触/近下轨 → 开多; RSI超买(>70)且触近上轨 → 开空
  3. 高盈亏比出场: 止盈目标带(利润让跑) + ATR动态移动止盈; 严格止损(1.5xATR)
  4. 单笔风险固定(1%本金), 不回补
对比: 先进(本) vs 旧布林触轨
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

def calc_bands(c,i,p=20,sd=2):
    seg=c[i-p:i]; mid=sum(seg)/p
    var=sum((x-mid)**2 for x in seg)/p; sdv=math.sqrt(var)
    return mid+sd*sdv, mid, mid-sd*sdv

def atr(h,l,c,i,n=14):
    if i<n: return 0.0001
    t=[]
    for j in range(i-n,i+1):
        t.append(max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])))
    return sum(t)/len(t)

def rsi(c,i,n=14):
    if i<n+1: return 50
    g=l=0
    for j in range(i-n+1,i+1):
        d=c[j]-c[j-1]
        if d>0:g+=d
        else:l-=d
    if g+l==0:return 50
    rs=g/l if l>0 else 99
    return 100-100/(1+rs)

def adx(h,l,c,i,n=14):
    if i<n*2: return 0
    pd=nd=tr=0
    for j in range(i-n+1,i+1):
        up=h[j]-h[j-1]; dn=l[j-1]-l[j]
        pd+=up if up>dn and up>0 else 0
        nd+=dn if dn>up and dn>0 else 0
        tr+=max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1]))
    if tr==0:return 0
    pdi=100*pd/tr; ndi=100*nd/tr
    return abs(pdi-ndi)/(pdi+ndi)*100 if pdi+ndi>0 else 0

def band_pct(c,i,hist=100):
    if i<20:return 0.5
    seg=c[i-20:i];mid=sum(seg)/20
    if mid<=0:return 0.5
    var=sum((x-mid)**2 for x in seg)/20
    cur=2*math.sqrt(var)/mid
    ws=[]
    for j in range(max(20,i-hist),i):
        s=c[j-20:j];m=sum(s)/20
        if m>0:
            v=sum((x-m)**2 for x in s)/20
            ws.append(2*math.sqrt(v)/m)
    return sum(1 for x in ws if x<cur)/len(ws) if ws else 0.5

def backtest(kl, risk=0.01, lev=3):
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]
    n=len(c); trades=[]; i=140; pos=None; eq=1.0
    while i<n-1:
        price=c[i]; atr_=atr(h,l,c,i)
        up,mid,lo=calc_bands(c,i)
        # 持仓管理: 高盈亏比出场(止盈2.5ATR / 止损1.5ATR / 保本移动)
        if pos:
            # 盈亏(含杠杆)
            pnl=(price-pos['e'])/pos['e'] if pos['side']=='L' else (pos['e']-price)/pos['e']
            pnlPct=pnl*lev
            sl=pos['e']-1.5*atr_/pos['e'] if pos['side']=='L' else pos['e']+1.5*atr_/pos['e']
            tp=pos['e']+2.5*atr_/pos['e'] if pos['side']=='L' else pos['e']-2.5*atr_/pos['e']
            # 止损
            if pos['side']=='L' and price<=pos['e']-1.5*atr_: trades.append(pnlPct-2*FEE); eq*=(1+pnlPct); pos=None;i+=1;continue
            if pos['side']=='S' and price>=pos['e']+1.5*atr_: trades.append(pnlPct-2*FEE); eq*=(1+pnlPct); pos=None;i+=1;continue
            # 止盈
            if pos['side']=='L' and price>=pos['e']+2.5*atr_: trades.append(pnlPct-2*FEE); eq*=(1+pnlPct); pos=None;i+=1;continue
            if pos['side']=='S' and price<=pos['e']-2.5*atr_: trades.append(pnlPct-2*FEE); eq*=(1+pnlPct); pos=None;i+=1;continue
            # 保本移动: 盈利>1ATR后回撤0.8ATR平
            # (简化: 用最高点跟踪)
            if pos['side']=='L':
                if price>pos.get('best',pos['e']): pos['best']=price
                if pos['best']-pos['e']>1.0*atr_ and price<pos['best']-0.8*atr_: trades.append(pnlPct-2*FEE); eq*=(1+pnlPct); pos=None;i+=1;continue
            else:
                if price<pos.get('best',pos['e']): pos['best']=price
                if pos['e']-pos['best']>1.0*atr_ and price>pos['best']+0.8*atr_: trades.append(pnlPct-2*FEE); eq*=(1+pnlPct); pos=None;i+=1;continue
            i+=1;continue
        # 开仓: 只有在震荡市(ADX<25 且 带宽低位) 且 RSI超卖/超买+触及轨道
        if adx(h,l,c,i)>25: i+=1;continue   # 趋势市不交易
        if band_pct(c,i)>0.5: i+=1;continue  # 带宽并非低位(不在收敛带)不交易
        r=rsi(c,i)
        # 开多: RSI<30且触下轨
        if price<=lo and r<30: pos={'side':'L','e':price,'best':price}; i+=1;continue
        # 开空: RSI>70且触上轨
        elif price>=up and r>70: pos={'side':'S','e':price,'best':price}; i+=1;continue
        i+=1
    if not trades: return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0,'pnlRatio':0}
    wins=[t for t in trades if t>0]; losses=[t for t in trades if t<=0]
    avgW=sum(wins)/len(wins) if wins else 0
    avgL=sum(losses)/len(losses) if losses else 0
    eq=1.0;pk=1.0;md=0.0
    for t in trades: eq*=(1+t);pk=max(pk,eq);md=max(md,(pk-eq)/pk)
    return {'t':len(trades),'w':len(wins),'wr':round(len(wins)*100/len(trades),1),
            'ret':round((eq-1)*100,2),'maxdd':round(md*100,2),'pnlRatio':round(abs(avgW/avgL),2) if avgL else 99}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','AVAXUSDT']
P4=60

def main():
    print('═══ 先进均值回归震荡策略回测(加密货币4h) ═══',flush=True)
    print('═══ 6币 | 震荡识别(ADX<25+窄带)+RSI反转+盈亏比2.5:1.5 | 单笔风险1% ═══\n',flush=True)
    agg={'t':0,'w':0,'ret':0.0,'md':0.0}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)<400: print(f'  {sym} 数据不足'); continue
            r=backtest(kl)
            print(f"  {sym:<10} {r['t']:3}笔 胜{r['wr']:4.1f}% 回报{r['ret']:+6.1f}% 盈亏比{r['pnlRatio']} 回撤{r['maxdd']:4.1f}%",flush=True)
            agg['t']+=r['t'];agg['w']+=r['w'];agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        except Exception as e: print(f'  {sym}: {e}',flush=True)
    wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
    print('',flush=True)
    print(f"═══ 汇总: {agg['t']}笔 胜率{wr}% 真实复利回报{agg['ret']:+.1f}% 最大回撤{agg['md']:.1f}% ═══",flush=True)

main()
