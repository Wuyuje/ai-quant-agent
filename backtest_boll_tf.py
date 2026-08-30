#!/usr/bin/env python3
"""布林震荡策略 多时间级别对比回测
对比 5min/15min/1h/4h 级别在同一逻辑下效果
逻辑(截图): 触轨开仓(触下轨开多/触上轨开空) + 带宽门禁(带宽100根分位>90%禁开/<85%+3根收窄解禁)
          止盈: 浮盈≥2%触中轨/反向轨或放量ATR; 止损: 单K浮亏20%
          多层周期: RSI<35多/RSI>65空确认(简化: 触轨方向+RSI)
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

def atr_at(h,l,c,i,n=14):
    if i<n: return 0
    trs=[]
    for j in range(i-n,i+1):
        trs.append(max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])))
    return sum(trs)/len(trs)

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

def bandwidth_pct(c,i,p=20,hist=100):
    """带宽100根历史分位 + 收窄"""
    if i<p: return 0.5, False
    seg=c[i-p:i]; mid=sum(seg)/p
    var=sum((x-mid)**2 for x in seg)/p; sdv=math.sqrt(var)
    cur=(2*sdv)/mid if mid>0 else 0
    # 历史100根带宽
    widths=[]
    for j in range(max(p,i-hist),i):
        s2=c[j-p:j]; m2=sum(s2)/p
        if m2>0:
            v2=sum((x-m2)**2 for x in s2)/p
            widths.append(2*math.sqrt(v2)/m2)
    pct=sum(1 for w in widths if w<cur)/len(widths) if widths else 0.5
    # 收窄: 最近3根带宽递减
    recent=widths[-4:] if len(widths)>=4 else widths
    shrink= len(recent)>=3 and all(recent[k+1]<recent[k] for k in range(len(recent)-1))
    return pct, shrink

def backtest(kl):
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]
    n=len(c); trades=[]; pos=None; i=120
    while i<n-1:
        price=c[i]; atr=atr_at(h,l,c,i) or 0.0001
        up,mid,lo=calc_bands(c,i)
        # 持仓管理
        if pos:
            pnl=(price-pos['e'])/pos['e'] if pos['side']=='L' else (pos['e']-price)/pos['e']
            # 止盈: 浮盈≥2%触中轨/反向轨
            if pos['side']=='L':
                if pnl>=0.02 and price>=mid: trades.append(pnl-2*FEE); pos=None;i+=1;continue
                if price>=up and pnl>0: trades.append(pnl-2*FEE); pos=None;i+=1;continue
            else:
                if pnl>=0.02 and price<=mid: trades.append(pnl-2*FEE); pos=None;i+=1;continue
                if price<=lo and pnl>0: trades.append(pnl-2*FEE); pos=None;i+=1;continue
            # 止损: 单K浮亏20%(本金口径×杠杆)
            lev=3
            if pnl<=-0.05/lev: trades.append(pnl-2*FEE); pos=None;i+=1;continue  # 简化止损
            i+=1;continue
        # 开仓: 带宽门禁
        bw_pct,shrink=bandwidth_pct(c,i)
        if bw_pct>0.9: i+=1;continue  # 禁开
        if not(bw_pct<0.85 and shrink): i+=1;continue  # 未解禁
        rsi=rsi_at(c,i)
        # 触轨
        if price<=lo and rsi<65:  # 触下轨开多(非超买)
            pos={'side':'L','e':price}; i+=1;continue
        elif price>=up and rsi>35:  # 触上轨开空
            pos={'side':'S','e':price}; i+=1;continue
        i+=1
    if not trades: return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(trades)
    for t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),'ret':round(gross*100,2),'maxdd':round(md*100,2)}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT']
TFS=[('5min',5,'5m',14),('15min',15,'15m',5),('1h',60,'1h',4),('4h',240,'4h',2)]
# 每tf大致取6个月等段时间范围

def main():
    print('═══ 布林震荡策略 多时间级别对比回测 ═══',flush=True)
    print('═══ 6币 | 带宽门禁+触轨+RSI+止盈止损 | 费0.1% ═══\n',flush=True)
    for label,mins,iv,pages in TFS:
        agg={'t':0,'w':0,'ret':0.0,'md':0.0}
        line=f'  {label:<6} '
        for sym in SYMS:
            try:
                kl=get_k(sym,iv,pages)
                if len(kl)<400: continue
                r=backtest(kl)
                agg['t']+=r['t'];agg['w']+=r['w'];agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
            except: pass
        wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
        print(f"  {label:<6} {agg['t']:4}笔 胜{wr:4.1f}% 回报{agg['ret']:+7.1f}% 回撤{agg['md']:5.1f}%",flush=True)

main()
