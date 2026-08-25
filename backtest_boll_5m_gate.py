#!/usr/bin/env python3
"""回测对比: 布林策略5分钟触轨开仓, 有/无「趋势方向门禁」
A组(无门禁): 触下轨/上轨直接开仓(原版) — 5m级别
B组(有门禁): 触轨信号后, 用4h EMA7/25/99判大趋势方向, UP只多/DOWN只空/FLAT不开+强趋势EMA差>3%回避(改造版)
范围: 布林池主流币(TAO/DOGE/ADA/APT/SOL/JUP), 最近6个月
风控: 带宽门禁 + 止盈(浮盈≥1%触中轨/上轨) + 硬止损(单K浮亏20%) + 0.1%费 (两版一致)
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
        for attempt in range(3):
            try:
                b=json.loads(urllib.request.urlopen(req,timeout=15).read().decode())
                ok=True;break
            except:
                time.sleep(0.3)
        if not ok:break
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.06)
    data.sort(key=lambda x:x[0])
    # ts, open, high, low, close, vol
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def _atr_array(highs,lows,closes,n=14):
    m=len(closes); atr=[1.0]*m; trs=[]
    for i in range(1,m):
        trs.append(max(highs[i]-lows[i],abs(highs[i]-closes[i-1]),abs(lows[i]-closes[i-1])))
        if i>=n: atr[i]=sum(trs[i-n:i])/n
        elif trs: atr[i]=sum(trs)/len(trs)
    return atr

def calc_bands(closes,i,period=20,sd=2):
    seg=closes[i-period:i]; mid=sum(seg)/period
    var=sum((x-mid)**2 for x in seg)/period; sdv=math.sqrt(var)
    return mid+sd*sdv, mid, mid-sd*sdv

def ema_list(closes,n):
    k=2/(n+1); e=closes[0]; out=[e]
    for i in range(1,len(closes)):
        e=closes[i]*k+e*(1-k); out.append(e)
    return out

def trend_at(kl4, ts):
    """4h趋势方向门禁: 在5m时刻ts前, 用最新4h EMA7/25/99判方向
    返回 dir(spread) 或 None(数据不足)"""
    closes=[x[4] for x in kl4 if x[0]<=ts]
    if len(closes)<60: return None
    e7=ema_list(closes,7)[-1]; e25=ema_list(closes,25)[-1]; e99=ema_list(closes,99)[-1]
    if e7>e25 and e25>e99: d='UP'
    elif e7<e25 and e25<e99: d='DOWN'
    else: d='FLAT'
    spread=abs(e7-e25)/(e25 or 1)*100
    return d, spread

def run_backtest(kl5, kl4, with_gate, band_open=0.99, band_release=0.98, gate_max=3):
    closes=[x[4] for x in kl5]; highs=[x[2] for x in kl5]; lows=[x[3] for x in kl5]
    ts=[x[0] for x in kl5]; n=len(closes)
    atr_arr=_atr_array(highs,lows,closes)
    trades=[]; fl_band=0; fl_gate=0; i=120
    while i<n-3:
        price=closes[i]
        if i<20:i+=1;continue
        upper,mid,lower=calc_bands(closes,i)
        if not(upper>lower): i+=1;continue
        cur_width=(upper-lower)/(mid or 1)
        if i>=120:
            widths=[]
            for j in range(i-100,i):
                if j<20:continue
                u,m,l=calc_bands(closes,j)
                if m>0: widths.append((u-l)/m)
            width_pct=sum(1 for w in widths if w>=cur_width)/len(widths) if widths else 0.5
        else: width_pct=0.5
        if width_pct>band_open: fl_band+=1;i+=1;continue
        if width_pct>band_release: fl_band+=1;i+=1;continue
        sig=None
        if price<=lower: sig='LONG'
        elif price>=upper: sig='SHORT'
        if not sig: i+=1;continue
        # ═══ 趋势方向门禁(仅B组) ═══
        if with_gate:
            td=trend_at(kl4, ts[i])
            if td is None: fl_gate+=1;i+=1;continue
            d,spread=td
            if d=='FLAT': fl_gate+=1;i+=1;continue
            if spread>gate_max: fl_gate+=1;i+=1;continue
            if not((d=='UP' and sig=='LONG') or (d=='DOWN' and sig=='SHORT')):
                fl_gate+=1;i+=1;continue
        entry=price;best=price;closed=None
        j=i+1; exit_j=None
        while j<min(i+2000,n):
            p=closes[j]; atr=atr_arr[j]
            if sig=='LONG':
                if p>best:best=p
                pnl=(p-entry)/entry
                if pnl>=0.01 and p>=mid: closed=(p-entry)/entry-2*FEE;exit_j=j;break
                if pnl<=-0.20: closed=pnl-2*FEE;exit_j=j;break
                if p>=upper: closed=(p-entry)/entry-2*FEE;exit_j=j;break
                s=best-0.7*atr
                if p<=s and p>entry: closed=(s-entry)/entry-2*FEE;exit_j=j;break
            else:
                if p<best:best=p
                pnl=(entry-p)/entry
                if pnl>=0.01 and p<=mid: closed=(entry-p)/entry-2*FEE;exit_j=j;break
                if pnl<=-0.20: closed=-pnl-2*FEE;exit_j=j;break
                if p<=lower: closed=(entry-p)/entry-2*FEE;exit_j=j;break
                s=best+0.7*atr
                if p>=s and p<entry: closed=(entry-s)/entry-2*FEE;exit_j=j;break
            j+=1
        if closed is None: i+=1
        else: trades.append((exit_j,closed)); i=exit_j+1
    if not trades:
        return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0,'filters':fl_band,'gate':fl_gate}
    wins=sum(1 for _,t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(t for _,t in trades)
    for _,t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),
            'ret':round(gross*100,2),'maxdd':round(md*100,2),'filters':fl_band,'gate':fl_gate,
            'net':round((eq-1)*100,2)}

SYMS=['TAOUSDT','DOGEUSDT','ADAUSDT','APTUSDT','SOLUSDT','JUPUSDT']
P5=52   # 6个月 5m
P4=55   # 6个月 4h

def main():
    print('═══ 布林5m触轨 回测对比: 无门禁 vs 有趋势方向门禁 ═══',flush=True)
    print('═══ 币: TAO/DOGE/ADA/APT/SOL/JUP | 6个月 | 费0.1% | 门禁:4h EMA方向+3% ═══\n',flush=True)
    agg_A={'t':0,'w':0,'gross':0.0,'net':1.0,'md':0.0}; agg_B={'t':0,'w':0,'gross':0.0,'net':1.0,'md':0.0}
    for sym in SYMS:
        try:
            print(f'拉取 {sym} 5m + 4h 数据...',flush=True)
            kl5=get_k(sym,'5m',P5); kl4=get_k(sym,'4h',P4)
            if len(kl5)<2000 or len(kl4)<60:
                print(f'  {sym}: 数据不足({len(kl5)}/5m,{len(kl4)}/4h),跳过',flush=True);continue
            rA=run_backtest(kl5,kl4,False)
            rB=run_backtest(kl5,kl4,True)
            print(f"  {sym:<10} 无门禁: {rA['t']:4}笔 胜{rA['wr']:4.1f}% 回报{rA['ret']:+7.1f}% 回撤{rA['maxdd']:5.1f}% | 门禁: {rB['t']:4}笔 胜{rB['wr']:4.1f}% 回报{rB['ret']:+7.1f}% 回撤{rB['maxdd']:5.1f}% (拦{rB['gate']})",flush=True)
            agg_A['t']+=rA['t'];agg_A['w']+=rA['w'];agg_A['gross']+=rA['ret'];agg_A['md']=max(agg_A['md'],rA['maxdd'])
            agg_B['t']+=rB['t'];agg_B['w']+=rB['w'];agg_B['gross']+=rB['ret'];agg_B['md']=max(agg_B['md'],rB['maxdd'])
        except Exception as e:
            print(f'  {sym}: 出错 {e}',flush=True)
    print('',flush=True)
    wa=round(agg_A['w']*100/agg_A['t'],1) if agg_A['t'] else 0
    wb=round(agg_B['w']*100/agg_B['t'],1) if agg_B['t'] else 0
    print('═══ 汇总 ═══',flush=True)
    print(f"  无门禁: {agg_A['t']}笔 胜率{wa}% 累计回报{agg_A['gross']:+.2f}% 最大回撤{agg_A['md']:.2f}%",flush=True)
    print(f"  有门禁: {agg_B['t']}笔 胜率{wb}% 累计回报{agg_B['gross']:+.2f}% 最大回撤{agg_B['md']:.2f}%",flush=True)

main()
