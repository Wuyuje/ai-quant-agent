#!/usr/bin/env python3
"""布林策略回测: 5分钟级别 + 真正触上下轨开仓
需求: 真正触及上下轨(price<=lower开多 / price>=upper开空), 非接近1.0ATR
范围: 当前布林池主流币(TAO/DOGE/ADA/APT/SOL/JUP), 最近6个月 5m K线
风控: 带宽门禁(分位>99%禁开,<98%解禁) + 止盈(浮盈≥1%触中轨/触上轨) + 硬止损(单K浮亏20%)
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
    # 返回完整 OHLCV
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def _atr(highs,lows,closes,n=14):
    trs=[]
    for i in range(1,len(closes)):
        trs.append(max(highs[i]-lows[i],abs(highs[i]-closes[i-1]),abs(lows[i]-closes[i-1])))
    return sum(trs[-n:])/n if len(trs)>=n else None

def calc_bands(closes,i,period=20,sd=2):
    seg=closes[i-period:i]
    mid=sum(seg)/period
    var=sum((x-mid)**2 for x in seg)/period
    sdv=math.sqrt(var)
    upper=mid+sd*sdv;lower=mid-sd*sdv
    return upper,mid,lower

def _atr_array(highs,lows,closes,n=14):
    """预计算每个索引的ATR(14)"""
    m=len(closes); atr=[1.0]*m
    trs=[]
    for i in range(1,m):
        trs.append(max(highs[i]-lows[i],abs(highs[i]-closes[i-1]),abs(lows[i]-closes[i-1])))
        if i>=n:
            atr[i]=sum(trs[i-n:i])/n
        elif len(trs)>0:
            atr[i]=sum(trs)/len(trs)
    return atr

def backtest_boll(kl, band_open=0.99, band_release=0.98):
    closes=[x[4] for x in kl]; highs=[x[2] for x in kl]; lows=[x[3] for x in kl]
    n=len(closes)
    atr_arr=_atr_array(highs,lows,closes)
    trades=[]; fl_band=0; i=120
    while i<n-3:
        price=closes[i]
        if i<20:i+=1;continue
        upper,mid,lower=calc_bands(closes,i)
        if not (upper>lower):i+=1;continue
        # 带宽分位(近100根历史中, 当前带宽在历史分位)
        cur_width=(upper-lower)/(mid or 1)
        if i>=120:
            widths=[]
            for j in range(i-100,i):
                if j<20:continue
                u,m,l=calc_bands(closes,j)
                if m>0:widths.append((u-l)/m)
            width_pct = sum(1 for w in widths if w>=cur_width)/len(widths) if widths else 0.5
        else:
            width_pct=0.5
        # 带宽门禁: 分位>99%禁开; 需<98%解禁
        if width_pct>band_open: fl_band+=1;i+=1;continue
        if width_pct>band_release: fl_band+=1;i+=1;continue
        # 真正触轨开仓
        sig=None
        if price<=lower: sig='LONG'
        elif price>=upper: sig='SHORT'
        if not sig:i+=1;continue
        entry=price;best=price;closed=None
        j=i+1; exit_j=None
        while j<min(i+2000,n):
            p=closes[j]
            atr=atr_arr[j]
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
        if closed is None:
            i+=1
        else:
            trades.append((exit_j,closed))
            i=exit_j+1
    if not trades:
        return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0,'filters':fl_band,'grossRet':0.0}
    wins=sum(1 for _,t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0;gross=sum(t for _,t in trades)
    for _,t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':round(wins*100/len(trades),1),'ret':round(gross*100,2),
            'maxdd':round(md*100,2),'filters':fl_band,'netRetPct':round(eq*100,2)}

# 当前布林池在用币 + 相关主流
SYMS=['TAOUSDT','DOGEUSDT','ADAUSDT','APTUSDT','SOLUSDT','JUPUSDT']
PAGES=52  # 6个月 5m ≈ 51840根 ≈ 52页

def main():
    print('═══ 布林策略回测: 5分钟 + 真正触上下轨开仓 ═══',flush=True)
    print('═══ 币种: TAO/DOGE/ADA/APT/SOL/JUP, 最近6个月, 费0.1% ═══\n',flush=True)
    agg_t=agg_w=0; agg_gross=0.0; agg_md=0.0; agg_f=0
    for sym in SYMS:
        try:
            sys.stdout.flush()
            print(f'拉取 {sym} 6个月 5m 数据...',flush=True)
            kl=get_k(sym,'5m',PAGES)
            days=len(kl)/(24*12)
            print(f'  {sym}: {len(kl)}根({days:.1f}天)',flush=True)
            if len(kl)<2000:
                print(f'  {sym}: 数据不足,跳过',flush=True);continue
            r=backtest_boll(kl)
            print(f"  {sym:<10} {r['t']:3}笔 胜{r['wr']:4.1f}% 总回报{r['ret']:+7.2f}% 最大回撤{r['maxdd']:5.2f}% 带宽过滤{r['filters']}",flush=True)
            agg_t+=r['t'];agg_w+=r['w'];agg_gross+=r['ret'];agg_md=max(agg_md,r['maxdd']);agg_f+=r['filters']
        except Exception as e:
            print(f'  {sym}: 出错 {e}',flush=True)
    print('',flush=True)
    wr=round(agg_w*100/agg_t,1) if agg_t else 0
    print(f"═══ 汇总(6币6个月): {agg_t}笔 胜率{wr}% 累计回报{agg_gross:+.2f}% 最大回撤{agg_md:.2f}% 带宽过滤{agg_f} ═══",flush=True)

main()
