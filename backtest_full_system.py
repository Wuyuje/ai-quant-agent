#!/usr/bin/env python3
"""当前系统完整策略回测: 市场状态切换 + 趋势顺势(涨多/跌空) + 布林震荡(高抛低吸)
严格模拟当前agent-manager分池逻辑:
  趋势市(trending): 趋势策略顺势, UP破前高做多/DOWN破前低做空, 止损0.8ATR/止盈2ATR
  震荡市(ranging): 布林触轨高抛低吸, 触下轨做多/触上轨做空, 止盈触中轨, 止损
  剧烈波动(shock): 观望
用真实4h数据回测8币, 评估能否赚钱 + 回撤可控
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
        data=b+data;et=str(b[0][0]);time.sleep(0.05)
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
    return abs(100*pdi/tr-100*ndi/tr)/((100*pdi/tr+100*ndi/tr) or 1)*100 if (100*pdi/tr+100*ndi/tr)>0 else 0

def calc_bands(c,i,p=20,sd=2):
    seg=c[i-p:i]; mid=sum(seg)/p
    var=sum((x-mid)**2 for x in seg)/p; sdv=math.sqrt(var)
    return mid+sd*sdv, mid, mid-sd*sdv

def market_state(c,h,l,i):
    """市场状态: TREND(UP/DOWN) 或 OSC + SHOCK"""
    # shock: 波动过大
    e7=ema_at(c,i,7); e25=ema_at(c,i,25); e99=ema_at(c,i,99)
    adx=adx_at(h,l,c,i)
    if adx<20:  # 无趋势→震荡
        up,mid,lo=calc_bands(c,i)
        vol=(up-lo)/(mid or 1)
        if vol>0.08: return 'SHOCK', 'FLAT'   # 带宽过宽=剧烈波动观望
        return 'OSC','FLAT'
    # 有趋势→趋势市, 方向由EMA排列
    if None in (e7,e25,e99): return 'OSC','FLAT'
    if e7>e25: return 'TREND','UP'
    if e7<e25: return 'TREND','DOWN'
    return 'OSC','FLAT'

def backtest(kl):
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]
    n=len(c); trades=[]; pos=None; i=100
    while i<n-1:
        price=c[i]; atr=atr_at(h,l,c,i) or 0.0001
        up,mid,lo=calc_bands(c,i)
        # 持仓管理
        if pos:
            pnl=(price-pos['e'])/pos['e'] if pos['side']=='L' else (pos['e']-price)/pos['e']
            # 止损: 趋势0.8ATR / 布林单K浮亏
            stop_dist=0.8*atr/price
            if pos['strat']=='trend':
                # 止损0.8ATR, 止盈2ATR(两阶段锁利简化: 移动存档)
                if pos['side']=='L' and price<=pos['e']-0.8*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pos['side']=='S' and price>=pos['e']+0.8*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pnl>=0.02:  # 锁利: 回撤1%平
                    best=pos.get('best',pos['e'])
                    if pos['side']=='L':
                        if price>best: pos['best']=price
                        if price<=best*(1-0.01): trades.append(pnl-2*FEE); pos=None; i+=1; continue
                    else:
                        if price<best: pos['best']=price
                        if price>=best*(1+0.01): trades.append(pnl-2*FEE); pos=None; i+=1; continue
                # 止盈2ATR
                if pos['side']=='L' and price>=pos['e']+2*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pos['side']=='S' and price<=pos['e']-2*atr: trades.append(pnl-2*FEE); pos=None; i+=1; continue
            else:  # 震荡(布林): 触中轨止盈 / 止损
                if abs(pnl)>=0.02: trades.append(pnl-2*FEE); pos=None; i+=1; continue  # 简化止损
                if pos['side']=='L' and price>=mid and pnl>0: trades.append(pnl-2*FEE); pos=None; i+=1; continue
                if pos['side']=='S' and price<=mid and pnl>0: trades.append(pnl-2*FEE); pos=None; i+=1; continue
            i+=1; continue
        # 开仓: 市场状态切换
        st,dir_=market_state(c,h,l,i)
        if st=='SHOCK': i+=1; continue  # 观望
        if st=='TREND':
            # 趋势市顺势: 上涨破前高做多 / 下跌破前低做空
            hi=max(c[max(0,i-60):i]); lo=min(c[max(0,i-60):i])
            if dir_=='UP' and price>hi: pos={'side':'L','e':price,'strat':'trend'}; i+=1; continue
            if dir_=='DOWN' and price<lo: pos={'side':'S','e':price,'strat':'trend'}; i+=1; continue
        else:
            # 震荡市高抛低吸
            if price<=lo: pos={'side':'L','e':price,'strat':'osc'}; i+=1; continue
            if price>=up: pos={'side':'S','e':price,'strat':'osc'}; i+=1; continue
        i+=1
    if not trades: return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(trades)
    for t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),'ret':round(gross*100,2),'maxdd':round(md*100,2)}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT']
P4=72

def main():
    print('═══ 当前系统完整策略回测 (市场状态切换+趋势顺势+布林震荡) ═══',flush=True)
    print('═══ 8币 4h | 费0.1% | 趋势止损0.8ATR/止盈2ATR | 布林触轨高抛低吸 ═══\n',flush=True)
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
