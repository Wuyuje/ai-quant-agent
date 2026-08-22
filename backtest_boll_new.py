#!/usr/bin/env python3
"""布林策略回测(修改后): 4h级别 + 完整风控逻辑
当前系统逻辑:
- 4h K线触轨(触下轨开多/触上轨开空)
- 带宽门禁: 分位>99%禁开, <98%解禁(去掉连续收窄)
- 4h趋势过滤: EMA7-25差>3%禁开(放宽)
- 动态止损: 补0次=20%/补1次=15%
- 止盈: 浮盈≥1%触中轨平/放量ATR
对比: 原版(5m+严格) vs 修改后(4h+放宽)
"""
import urllib.request,json,time,math

UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005

def get_k(sym,iv,pages):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et:url+=f'&endTime={et}'
        req=urllib.request.Request(url,headers=UA)
        try:
            b=json.loads(urllib.request.urlopen(req,timeout=15).read().decode())
        except:
            time.sleep(0.3);continue
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.07)
    data.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[4])) for x in data]

def _ema_at(v,i,n):
    if i<n:return None
    k=2/(n+1);e=v[i-n+1]
    for x in range(i-n+2,i+1):e=v[x]*k+e*(1-k)
    return e

def _atr(closes,n=14):
    trs=[]
    for i in range(1,len(closes)):
        h=max(closes[max(0,i-4):i+1]);l=min(closes[max(0,i-4):i+1]);pc=closes[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs[-n:])/n if len(trs)>=n else None

def backtest(kl, threshold=3.0, open_pct=0.99, release_pct=0.98):
    c=[x[1] for x in kl]; ts=[x[0] for x in kl]
    trades=[];skip_trend=0;skip_band=0;i=130
    while i<len(c)-3:
        price=c[i];cur_ts=ts[i]
        if i<20:i+=1;continue
        # 布林(20,2)
        seg=c[i-20:i];mid=sum(seg)/20
        sd=math.sqrt(sum((x-mid)**2 for x in seg)/20)
        upper,lower=mid+2*sd,mid-2*sd
        # 带宽分位(简化: 近100根带宽对比, 用当前带宽/近100带宽最大值)
        cur_width=(upper-lower)/(mid or 1)
        width_pct=0.5
        if i>=120:
            widths=[]
            for j in range(i-100,i):
                s=c[j-20:j];m=sum(s)/20;d=math.sqrt(sum((x-m)**2 for x in s)/20)
                if m>0:widths.append(4*d/m)
            if widths:width_pct=sum(1 for w in widths if w<cur_width)/len(widths)
        # 带宽门禁
        if width_pct>open_pct:skip_band+=1;i+=1;continue
        if width_pct>release_pct:skip_band+=1;i+=1;continue  # 解禁需<98%
        # 4h趋势过滤(用当前价格平台EMA近似)
        e7=_ema_at(c,i,7);e25=_ema_at(c,i,25)
        spread=abs(e7-e25)/(e25 or 1)*100
        if spread>threshold:skip_trend+=1;i+=1;continue
        # 触轨信号
        sig=None
        if price<=lower:sig='LONG'
        elif price>=upper:sig='SHORT'
        if not sig:i+=1;continue
        # 持仓管理(动态止损+止盈)
        entry=price;best=entry;closed=None;add=0
        for j in range(i+1,min(i+3000,len(c))):
            p=c[j]
            loss_pct = 20 if add<1 else 15
            atr=_atr(c[max(0,j-14):j+1]) or 1
            pnl_pct = (p-entry)/entry*100 if sig=='LONG' else (entry-p)/entry*100
            # 前置风控(价格%×3x杠杆≈本金%, 简化用价格%)
            worst = (entry-min(c[i+1:j+1]))/entry*100 if sig=='LONG' else (max(c[i+1:j+1])-entry)/entry*100
            if worst>=loss_pct:
                closed=-worst/100*3-2*FEE;i=j+20;break
            # 止盈: 触中轨+浮盈>1%
            seg2=c[j-20:j];m2=sum(seg2)/20
            if sig=='LONG' and p>=m2 and pnl_pct>1:
                closed=pnl_pct/100-2*FEE;i=j+20;break
            if sig=='SHORT' and p<=m2 and pnl_pct>1:
                closed=pnl_pct/100-2*FEE;i=j+20;break
        if closed is None:i+=1
        else:trades.append(closed)
    if not trades:return {'t':0,'w':0,'wr':0,'ret':0,'maxdd':0,'skip_t':skip_trend,'skip_b':skip_band}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100,'skip_t':skip_trend,'skip_b':skip_band}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','SUIUSDT','INJUSDT','WLDUSDT','LTCUSDT','NEARUSDT','ADAUSDT','UNIUSDT','XRPUSDT']

print('═══ 布林策略回测(修改后): 4h级别+放宽过滤 ═══')
print('═══ 14币, 4h, 3个月(72页? 用6页约24天每个体), 费0.1% ═══\n')
# 4h 3个月≈550根=1页, 但拉更多保证覆盖
agg_t=agg_w=agg_ret=0;agg_md=0;skip_t=0;skip_b=0
for sym in SYMS:
    try:
        kl=get_k(sym,'4h',8)  # 8页=8000根4h≈很大范围
        if len(kl)<600:continue
        r=backtest(kl,3.0,0.99,0.98)
        agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);skip_t+=r['skip_t'];skip_b+=r['skip_b']
        print(f"  {sym:10} {r['t']:3}笔 胜{r['wr']:2}% 回报{r['ret']:+6.1f}% 回撤{r['maxdd']:.1f}%")
    except Exception as e:print(f"  {sym} err {str(e)[:20]}")
wr=agg_w*100//agg_t if agg_t else 0
print(f"\n═══ 汇总: {agg_t}笔 胜{wr}% 回报{agg_ret:+.1f}% 回撤{agg_md:.1f}% 趋势禁开{skip_t} 带宽禁{skip_b} ═══")
