#!/usr/bin/env python3
"""自适应市场策略回测: 趋势市(涨做多/跌做空) + 震荡市(高抛低吸) 自动切换
核心思路:
  1. 用ADX/趋势强度识别市场状态(趋势市 vs 震荡市)
  2. 趋势市(ADX高+有方向): 上涨→做多, 下跌→做空 (顺势)
  3. 震荡市(ADX低): 高抛低吸 (触布林下轨做多/触上轨做空)
  4. 严格止损 + 顺势方向控制, 任何市场都有应对
验证目标: 在历史数据(多种市场阶段)中证明能赚钱
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
    """简化ADX: 趋势强度(方向性指数)"""
    if i<n*2: return 0
    pdm=0;ndm=0;tr=0
    for j in range(i-n,i+1):
        up=h[j]-h[j-1]; dn=l[j-1]-l[j]
        pdm+=up if up>dn and up>0 else 0
        ndm+=dn if dn>up and dn>0 else 0
        tr+=max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1]))
    if tr==0: return 0
    pdi=100*pdm/tr; ndi=100*ndm/tr
    dx=abs(pdi-ndi)/((pdi+ndi) or 1)*100
    return dx

def boll_at(c,i,p=20,sd=2):
    seg=c[i-p:i]; mid=sum(seg)/p
    var=sum((x-mid)**2 for x in seg)/p; sdv=math.sqrt(var)
    return mid+sd*sdv, mid, mid-sd*sdv

def market_state(h,l,c,i):
    """识别市场状态: 'TREND' 趋势市(做顺势) / 'OSC' 震荡市(高抛低吸)"""
    adx=adx_at(h,l,c,i)
    e7=ema_at(c,i,7); e25=ema_at(c,i,25)
    if e7 is None or e25 is None: return 'OSC', 0
    spread=abs(e7-e25)/(e25 or 1)*100
    dir_='UP' if e7>e25 else 'DOWN'
    # ADX>20 = 有趋势, 震荡市记入方向
    if adx>=20 and spread>=0.5:
        return 'TREND', dir_
    return 'OSC', dir_

def backtest(kl):
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]
    n=len(c); trades=[]; pos=None; i=100
    while i<n-1:
        # 持有中的仓位: 止损/止盈管理
        if pos:
            price=c[i]; atr=atr_at(h,l,c,i) or 0.0001
            pnl=(price-pos['entry'])/pos['entry'] if pos['side']=='LONG' else (pos['entry']-price)/pos['entry']
            # 止损: 2ATR 或 -3%
            stop=pos['entry']*(1-2*atr/pos['entry'] if pos['side']=='LONG' else (1+2*atr/pos['entry']))
            sl_pct=-0.015
            # 止盈: LONG 5%, SHORT 5%
            tp_pct=0.02
            if (pos['side']=='LONG' and price<=stop) or (pos['side']=='SHORT' and price>=stop) or pnl<=sl_pct:
                trades.append(pnl-2*FEE); pos=None; i+=1; continue
            if (pos['side']=='LONG' and pnl>=tp_pct) or (pos['side']=='SHORT' and pnl>=tp_pct):
                trades.append(pnl-2*FEE); pos=None; i+=1; continue
            i+=1; continue
        # 开仓逻辑
        up_h,mid,up_l=boll_at(c,i)
        price=c[i]
        st,dir_=market_state(h,l,c,i)
        if st=='TREND':
            # 趋势市: 顺势 (上涨做多/下跌做空) - 可开仓
            if dir_=='UP' and price>(up_h+mid)/2:  # 上涨市顺势做多(更强)
                pos={'side':'LONG','entry':price}; i+=1; continue
            elif dir_=='DOWN' and price<(up_l+mid)/2:  # 下跌市顺势做空(更强)
                pos={'side':'SHORT','entry':price}; i+=1; continue
        else:
            # 震荡市: 高抛低吸
            if price<=up_l:  # 触下轨做多
                pos={'side':'LONG','entry':price}; i+=1; continue
            elif price>=up_h:  # 触上轨做空
                pos={'side':'SHORT','entry':price}; i+=1; continue
        i+=1
    if not trades: return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(trades)
    for t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),'ret':round(gross*100,2),'maxdd':round(md*100,2)}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT']
P4=72  # 12个月 4h

def main():
    print('═══ 自适应市场策略回测 (趋势市顺势 + 震荡市高抛低吸) ═══',flush=True)
    print('═══ 币: 8主流 | 4h | 费0.1% | 止损2ATR/3% 止盈5% ═══\n',flush=True)
    agg={'t':0,'w':0,'ret':0.0,'md':0.0}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)<600: print(f'  {sym}: 数据不足'); continue
            r=backtest(kl)
            print(f"  {sym:<10} {r['t']:4}笔 胜{r['wr']:4.1f}% 回报{r['ret']:+7.1f}% 回撤{r['maxdd']:5.1f}%",flush=True)
            agg['t']+=r['t'];agg['w']+=r['w'];agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        except Exception as e: print(f'  {sym}: {e}',flush=True)
    wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
    print('',flush=True)
    print(f"═══ 汇总(8币12月): {agg['t']}笔 胜率{wr}% 累加回报{agg['ret']:+.1f}% 最大回撤{agg['md']:.1f}% ═══",flush=True)

main()
