#!/usr/bin/env python3
"""4h级别回测: 布林策略顺势方向门禁阈值敏感性
线上布林是4h级别 → 此回测最贴近真实
触轨开仓(price<=lower开多/price>=upper开空) + 趋势方向门禁(4h EMA7/25/99)
对比门禁阈值: 无门禁 / 2% / 3% / 4%
风控: 带宽门禁(>99%禁,<98%解) + 止盈(浮盈≥1%触中轨/上轨) + 硬止损(浮亏20%) + 0.1%费
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
        data=b+data;et=str(b[0][0]);time.sleep(0.06)
    data.sort(key=lambda x:x[0])
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

def ema_at(closes,n):
    k=2/(n+1); e=closes[0]
    for i in range(1,len(closes)): e=closes[i]*k+e*(1-k)
    return e

def gate_check(closes_4h, sig, gate_max=None):
    """返回 (allowed, dir)"""
    if len(closes_4h)<60:
        return False,None
    e7=ema_at(closes_4h,7); e25=ema_at(closes_4h,25); e99=ema_at(closes_4h,99)
    if e7>e25 and e25>e99: d='UP'
    elif e7<e25 and e25<e99: d='DOWN'
    else: d='FLAT'
    if d=='FLAT': return False,d
    if gate_max is not None:
        spread=abs(e7-e25)/(e25 or 1)*100
        if spread>gate_max: return False,d
    if (d=='UP' and sig=='LONG') or (d=='DOWN' and sig=='SHORT'): return True,d
    return False,d

def run_backtest(kl, gate_max, band_open=0.99, band_release=0.98):
    closes=[x[4] for x in kl]; highs=[x[2] for x in kl]; lows=[x[3] for x in kl]
    n=len(closes); atr_arr=_atr_array(highs,lows,closes)
    trades=[]; fl_gate=0; i=120
    while i<n-3:
        price=closes[i]
        if i<20:i+=1;continue
        upper,mid,lower=calc_bands(closes,i)
        if not(upper>lower):i+=1;continue
        cur_width=(upper-lower)/(mid or 1)
        if i>=120:
            widths=[]
            for j in range(i-100,i):
                if j<20:continue
                u,m,l=calc_bands(closes,j)
                if m>0: widths.append((u-l)/m)
            width_pct=sum(1 for w in widths if w>=cur_width)/len(widths) if widths else 0.5
        else: width_pct=0.5
        if width_pct>band_open: i+=1;continue
        if width_pct>band_release: i+=1;continue
        sig=None
        if price<=lower: sig='LONG'
        elif price>=upper: sig='SHORT'
        if not sig: i+=1;continue
        if gate_max is not None:
            ok,_=gate_check(closes[:i+1], sig, gate_max)
            if not ok: fl_gate+=1;i+=1;continue
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
        return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0,'gate':fl_gate}
    wins=sum(1 for _,t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(t for _,t in trades)
    for _,t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),'ret':round(gross*100,2),
            'maxdd':round(md*100,2),'gate':fl_gate,'net':round((eq-1)*100,2)}

SYMS=['TAOUSDT','DOGEUSDT','ADAUSDT','APTUSDT','SOLUSDT','JUPUSDT']
P4=64  # 12个月 4h (~2190根/月 * 12 ≈ 26280 ≈ 27页; 拉到60页覆盖更多)

def main():
    print('═══ 4h级别回测: 布林触轨+趋势方向门禁(阈值敏感性) ═══',flush=True)
    print('═══ 币: TAO/DOGE/ADA/APT/SOL/JUP | 费0.1% | 门禁:无/2%/3%/4% ═══\n',flush=True)
    cfg=[('无门禁',None),('门禁2%',2),('门禁3%',3),('门禁4%',4)]
    agg={c[0]:{'t':0,'w':0,'gross':0.0,'md':0.0} for c in cfg}
    header='  {:<10}'.format('币')
    for name,_ in cfg: header+=f' | {name:<6}'
    print(header,flush=True)
    for sym in SYMS:
        try:
            print(f'拉取 {sym} 4h 数据...',flush=True)
            kl=get_k(sym,'4h',P4)
            if len(kl)<600:
                print(f'  {sym}: 数据不足({len(kl)}),跳过',flush=True);continue
            line=f'  {sym:<10}'
            for name,gm in cfg:
                r=run_backtest(kl,gm)
                line+=f' | {r["t"]:>3}笔{r["wr"]:>4.1f}%{r["ret"]:>+7.0f}%/{r["maxdd"]:.1f}%'
                agg[name]['t']+=r['t'];agg[name]['w']+=r['w'];agg[name]['gross']+=r['ret'];agg[name]['md']=max(agg[name]['md'],r['maxdd'])
            print(line,flush=True)
        except Exception as e:
            print(f'  {sym}: 出错 {e}',flush=True)
    print('',flush=True)
    print('═══ 汇总(4h, 6币) ═══',flush=True)
    for name,_ in cfg:
        a=agg[name]
        wr=round(a['w']*100/a['t'],1) if a['t'] else 0
        print(f'  {name:<8}: {a["t"]:>4}笔 胜率{wr:>4.1f}% 累计回报{a["gross"]:+8.1f}% 最大回撤{a["md"]:5.2f}%',flush=True)

main()
