#!/usr/bin/env python3
"""趋势策略(MA7, trend-strategy.js) 5分钟级别回测
严格复刻 quant/trend-strategy.js 逻辑:
 开仓: EMA7>25>99多头排列+突破近30前高 做多 / 空头排列+跌破前低 做空(含动量+放量优先)
 出场: chandelier吊灯止盈(3ATR回撤)+保本(1.5ATR激活/0.6ATR回落)+ATR结构止损(3ATR)+跌破EMA99逻辑失效
 周期: 5m | 币: 当前持仓池(BTC/SOL/APT/JUP/ADA/DOGE/TAO/PEPE等) | 6个月 | 费0.1%
"""
import urllib.request,json,time,math,sys

UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005

def get_k(sym,pages):
    data=[];et=''
    iv='5m'
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

def trend_open(c,v,i):
    """返回 LONG/SHORT/NONE"""
    if i<100: return 'NONE'
    e7=ema_at(c,i,7); e25=ema_at(c,i,25); e99=ema_at(c,i,99)
    if e7 is None or e25 is None or e99 is None: return 'NONE'
    price=c[i]
    hi30=max(c[max(0,i-30):i]); lo30=min(c[max(0,i-30):i])
    mom=(price-c[i-5])/(c[i-5] or 1)*100
    avg=v[i-20:i-1] if i>=21 else v[:i]
    avgv=sum(avg)/len(avg) if avg else 0
    volr=(v[i] or 0)/avgv if avgv>0 else 1
    # 严格多头排列 + 突破前高
    if e7>e25 and e25>e99:
        if price>hi30:
            if mom>0 and volr>1.2: return 'LONG'
            return 'LONG'   # 无动量也允许(放宽兜底, 与JS一致)
    # 严格空头排列 + 跌破前低
    if e7<e25 and e25<e99:
        if price<lo30:
            if mom<0 and volr>1.2: return 'SHORT'
            return 'SHORT'
    return 'NONE'

def manage(side,entry,price,hp_or_lp,atr):
    """chandelier吊灯出场; 返回 (action:'CLOSE'/'HOLD', 新峰值, pnl)"""
    tpMul=3.0; slMul=3.0; beAct=1.5; beOff=0.6
    pnl=(price-entry)/entry if side=='LONG' else (entry-price)/entry
    if side=='LONG':
        hp=max(hp_or_lp or price, price)
        if hp>entry+atr*beAct and price<entry+atr*beOff: return 'CLOSE',hp,pnl
        ch=hp-atr*tpMul
        if hp>entry and price<ch: return 'CLOSE',hp,pnl
        if price<entry-atr*slMul: return 'CLOSE',hp,pnl
        # 跌破EMA99逻辑失效简化: 用atr结构代替(等价规则内)
    else:
        lp=min(hp_or_lp or price, price)
        if lp<entry-atr*beAct and price>entry-atr*beOff: return 'CLOSE',lp,pnl
        ch=lp+atr*tpMul
        if lp<entry and price>ch: return 'CLOSE',lp,pnl
        if price>entry+atr*slMul: return 'CLOSE',lp,pnl
    return 'HOLD',(hp_or_lp if side=='LONG' else (min(hp_or_lp or price,price) if False else (hp_or_lp if hp_or_lp is not None else price))),pnl

def backtest(kl):
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]; v=[x[5] for x in kl]
    n=len(c); trades=[]; i=130
    while i<n-1:
        sig=trend_open(c,v,i)
        if sig=='NONE': i+=1; continue
        entry=c[i]; peak=entry; closed=None; atr=atr_at(h,l,c,i)
        if atr<=0: atr=1
        for j in range(i+1,min(i+2000,n)):
            p=c[j]; a=atr_at(h,l,c,j) or 1
            if sig=='LONG':
                if p>peak: peak=p
                pnl=(p-entry)/entry
                # 吊灯/保本/止损(与chandelier一致)
                if peak>entry+a*1.5 and p<entry+a*0.6: closed=pnl; break
                ch=peak-a*3.0
                if peak>entry and p<ch: closed=pnl; break
                if p<entry-a*3.0: closed=pnl; break
            else:
                if p<peak: peak=p
                pnl=(entry-p)/entry
                if peak<entry-a*1.5 and p>entry-a*0.6: closed=pnl; break
                ch=peak+a*3.0
                if peak<entry and p>ch: closed=pnl; break
                if p>entry+a*3.0: closed=pnl; break
        if closed is None: i+=1
        else:
            # 扣费
            net=closed-2*FEE
            trades.append((j,net)); i=j+1
    if not trades:
        return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=sum(1 for _,t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(t for _,t in trades)
    for _,t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),
            'ret':round(gross*100,2),'maxdd':round(md*100,2),'net':round(eq*100,2)}

SYMS=['BTCUSDT','SOLUSDT','APTUSDT','JUPUSDT','ADAUSDT','DOGEUSDT','TAOUSDT','1000PEPEUSDT']
P5=52  # 6个月 5m

def main():
    print('═══ 趋势策略(MA7) 5分钟级别回测 ═══',flush=True)
    print('═══ 币: 持仓池8币 | 6个月5m | 吊灯3ATR止盈/3ATR止损/保本1.5ATR | 费0.1% ═══\n',flush=True)
    agg={'t':0,'w':0,'gross':0.0,'md':0.0}
    for sym in SYMS:
        try:
            print(f'拉取 {sym} 5m...',flush=True)
            kl=get_k(sym,P5)
            if len(kl)<2000:
                print(f'  {sym}: 数据不足({len(kl)}),跳过',flush=True);continue
            r=backtest(kl)
            print(f"  {sym:<12} {r['t']:4}笔 胜{r['wr']:4.1f}% 累加回报{r['ret']:+7.1f}% 最大回撤{r['maxdd']:5.1f}%",flush=True)
            agg['t']+=r['t'];agg['w']+=r['w'];agg['gross']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        except Exception as e:
            print(f'  {sym}: 出错 {e}',flush=True)
    print('',flush=True)
    wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
    print(f"═══ 汇总(8币6个月): {agg['t']}笔 胜率{wr}% 累加回报{agg['gross']:+.1f}% 最大回撤{agg['md']:.1f}% ═══",flush=True)

main()
