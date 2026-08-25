#!/usr/bin/env python3
"""双策略回测: 改动前(只有趋势) vs 改动后(趋势优先+布林补充)
对比: 趋势无信号时是否落到布林开仓
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
        data=b+data;et=str(b[0][0]);time.sleep(0.05)
    data.sort(key=lambda x:x[0])
    return [float(x[4]) for x in data]

def _ema_at(c,i,n):
    if i<n:return None
    k=2/(n+1);e=c[i-n+1]
    for x in range(i-n+2,i+1):e=c[x]*k+e*(1-k)
    return e

def _atr(c,n=14):
    trs=[]
    for i in range(1,len(c)):
        h=max(c[max(0,i-3):i+1]);l=min(c[max(0,i-3):i+1]);pc=c[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs[-n:])/n if len(trs)>=n else None

def trend_sig(c,i):
    look=60
    if i<look+110:return None
    e7=_ema_at(c,i,7);e25=_ema_at(c,i,25);e99=_ema_at(c,i,99)
    if e7 is None or e25 is None or e99 is None:return None
    if e7>e25 and e25>e99:d='UP'
    elif e7<e25 and e25<e99:d='DOWN'
    else:return None
    price=c[i];e50=_ema_at(c,i,50) or price;mom=(price-e50)/e50*100
    g20=(price-c[max(0,i-20)])/c[max(0,i-20)]*100
    seg=c[max(0,i-19):i+1];hi20=max(seg);lo20=min(seg)
    pos20=(price-lo20)/((hi20-lo20) or 1)*100
    if d=='UP':
        hi=max(c[max(0,i-look):i])
        if price>hi and mom>1:
            if pos20>80 and abs(g20)>20:return None  # 高位过滤
            return 'LONG'
    elif d=='DOWN':
        lo=min(c[max(0,i-look):i])
        if price<lo and mom<-1:return 'SHORT'
    return None

def boll_sig(c,i):
    if i<20:return None
    seg=c[i-20:i];mid=sum(seg)/20
    sd=math.sqrt(sum((x-mid)**2 for x in seg)/20)
    upper,lower=mid+2*sd,mid-2*sd
    range_w=(upper-lower) or 1
    # 带宽分位
    width_pct=0.5
    if i>=120:
        cur_w=range_w/(mid or 1);ws=[]
        for j in range(i-100,i):
            s=c[j-20:j];m=sum(s)/20;d=math.sqrt(sum((x-m)**2 for x in s)/20)
            if m>0:ws.append(4*d/m)
        if ws:width_pct=sum(1 for w in ws if w<cur_w)/len(ws)
    if width_pct>0.98:return None
    # 趋势过滤(4h EMA差<5%)
    e7=_ema_at(c,i,7);e25=_ema_at(c,i,25)
    if e7 is None or e25 is None:return None
    spread=abs(e7-e25)/(e25 or 1)*100
    if spread>5:return None
    # 接近轨道20%
    price=c[i]
    if price-lower<=range_w*0.2:return 'LONG'
    if upper-price<=range_w*0.2:return 'SHORT'
    return None

def manage(c,i,sig,strat):
    entry=c[i];best=entry;closed=None
    for j in range(i+1,min(i+2000,len(c))):
        p=c[j];atr=_atr(c[max(0,j-14):j+1]) or 1
        pnl_pct=(p-entry)/entry*100 if sig=='LONG' else (entry-p)/entry*100
        if strat=='boll':
            # ═══ 布林(均值回归): 0.8ATR止损 + 触中轨止盈 ═══
            seg2=c[j-20:j];m2=sum(seg2)/20
            if sig=='LONG':
                if p>best:best=p
                s=max(entry-0.8*atr,best-0.7*atr)
                if p<=s:closed=(s-entry)/entry-2*FEE;i=j+20;break
                if p>=m2 and pnl_pct>1:closed=pnl_pct/100-2*FEE;i=j+20;break
            else:
                if p<best:best=p
                s=min(entry+0.8*atr,best+0.7*atr)
                if p>=s:closed=(entry-p)/entry-2*FEE;i=j+20;break
                if p<=m2 and pnl_pct>1:closed=pnl_pct/100-2*FEE;i=j+20;break
        else:
            # ═══ 趋势: 两阶段锁利(2%/1%) ═══
            if sig=='LONG':
                if p>best:best=p
                if pnl_pct>=2.0:stop=best*0.99
                else:stop=max(entry-0.8*atr,best-0.7*atr)
                tp=entry+2*atr
                if p<=stop:closed=pnl_pct/100-2*FEE;i=j+20;break
                if p>=tp:closed=pnl_pct/100-2*FEE;i=j+20;break
            else:
                if p<best:best=p
                if pnl_pct>=2.0:stop=best*1.01
                else:stop=min(entry+0.8*atr,best+0.7*atr)
                tp=entry-2*atr
                if p>=stop:closed=(entry-p)/entry-2*FEE;i=j+20;break
                if p<=tp:closed=pnl_pct/100-2*FEE;i=j+20;break
    return closed,i

def backtest(c, use_boll_fallback):
    # 同币互斥: 用set记录哪些币已开过仓(模拟)
    trades=[];n_trend=0;n_boll=0;i=170
    while i<len(c)-5:
        sig=trend_sig(c,i)
        strat='trend'
        if sig is None:
            if use_boll_fallback:
                sig=boll_sig(c,i)
                strat='boll'
            else:
                i+=1;continue
        if sig is None:i+=1;continue
        pnl,ni=manage(c,i,sig,strat)
        if pnl is None:i+=1
        else:
            trades.append((pnl,strat));i=ni
            if strat=='trend':n_trend+=1
            else:n_boll+=1
    if not trades:return {'t':0,'w':0,'wr':0,'ret':0,'maxdd':0,'trend':0,'boll':0}
    wins=sum(1 for t,_ in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t,_ in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(t for t,_ in trades)*100,'maxdd':md*100,'trend':n_trend,'boll':n_boll}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','SUIUSDT','WLDUSDT','LTCUSDT','NEARUSDT','ADAUSDT','XRPUSDT','OPUSDT','UNIUSDT']

print('═══ 双策略回测: 改动前vs改动后(趋势+布林, 14币,4h,3个月) ═══\n')
preloaded={sym:get_k(sym,'4h',6) for sym in SYMS}

for label,use_fb in [('改动前(只有趋势)',False),('改动后(趋势+布林补充)',True)]:
    agg_t=agg_w=agg_ret=0;agg_md=0;nt=nb=0
    for sym in SYMS:
        c=preloaded[sym]
        if len(c)<600:continue
        r=backtest(c,use_fb)
        agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);nt+=r['trend'];nb+=r['boll']
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"{label:30} {agg_t:4}笔 胜{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 趋势{nt}笔/布林{nb}笔")
