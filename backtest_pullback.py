#!/usr/bin/env python3
"""方案4: 回调介入回测 - 不在突破时追单, 等回调到EMA附近再买
对比: 原版突破追单 vs 方案3(涨幅过滤) vs 方案4(回调介入)
"""
import urllib.request,json,time,math

UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005
def get_k(sym,iv,pages=5):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et:url+=f'&endTime={et}'
        req=urllib.request.Request(url,headers=UA)
        b=json.loads(urllib.request.urlopen(req,timeout=12).read().decode())
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.1)
    data.sort(key=lambda x:x[0])
    return [float(x[4]) for x in data]

def _ema_at(closes,i,n):
    if i<n:return None
    k=2/(n+1);e=closes[i-n+1]
    for x in range(i-n+2,i+1):e=closes[x]*k+e*(1-k)
    return e

def _atr(closes,n=14):
    trs=[]
    for i in range(1,len(closes)):
        h=max(closes[max(0,i-4):i+1]);l=min(closes[max(0,i-4):i+1]);pc=closes[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs[-n:])/n if len(trs)>=n else None

def entry_original(closes,i,lookback=60):
    """原版: 突破前高追单"""
    if i<lookback+110:return None
    e7=_ema_at(closes,i,7);e25=_ema_at(closes,i,25);e99=_ema_at(closes,i,99)
    if e7 is None or e25 is None or e99 is None:return None
    if e7>e25 and e25>e99:d='UP'
    elif e7<e25 and e25<e99:d='DOWN'
    else:return None
    price=closes[i]
    if d=='UP':
        hi=max(closes[max(0,i-lookback):i]);e50=_ema_at(closes,i,50) or price
        if price>hi and (price-e50)/e50>0.01:return 'LONG'
    elif d=='DOWN':
        lo=min(closes[max(0,i-lookback):i]);e50=_ema_at(closes,i,50) or price
        if price<lo and (price-e50)/e50<-0.01:return 'SHORT'
    return None

def entry_filter(closes,i,lookback=60,filter_gain=20):
    """方案3: 突破追踪+涨幅过滤"""
    sig=entry_original(closes,i,lookback)
    if not sig:return None
    price=closes[i]
    g20=(price-closes[max(0,i-20)])/closes[max(0,i-20)]*100
    if abs(g20)>filter_gain:return 'FILTER'
    return sig

def entry_pullback(closes,i,lookback=60):
    """方案4: 回调介入 - 需先有突破, 然后回调到EMA20/EMA25附近再入场"""
    if i<lookback+110:return None
    e7=_ema_at(closes,i,7);e25=_ema_at(closes,i,25);e99=_ema_at(closes,i,99)
    if e7 is None or e25 is None or e99 is None:return None
    if e7>e25 and e25>e99:d='UP'
    elif e7<e25 and e25<e99:d='DOWN'
    else:return None
    price=closes[i]
    # 判断近期是否有突破(近30根内突破过前高)
    if d=='UP':
        # 近30根是否突破过(用EMA20做回调线)
        ema20=_ema_at(closes,i,20) or price
        # 已在向上趋势中, 且价格回调到EMA20附近(±1%) → 买入
        back_pct=(price-ema20)/ema20*100
        if -1.0<=back_pct<=1.0:
            return 'LONG'
    elif d=='DOWN':
        ema20=_ema_at(closes,i,20) or price
        back_pct=(ema20-price)/ema20*100
        if -1.0<=back_pct<=1.0:
            return 'SHORT'
    return None

def backtest(closes,entryf,stop=0.8,tp=2.0,trail=0.7):
    trades=[];fl=0;i=170
    while i<len(closes)-5:
        sig=entryf(closes,i)
        if sig is None:i+=1;continue
        if sig=='FILTER':fl+=1;i+=1;continue
        entry=closes[i];best=entry
        for j in range(i+1,min(i+3000,len(closes))):
            price=closes[j];atr=_atr(closes[max(0,j-14):j+1]) or 1
            if sig=='LONG':
                if price>best:best=price
                s=max(entry-stop*atr,best-trail*atr);tp_=entry+tp*atr
                if price<=s:pnl=(s-entry)/entry-2*FEE;trades.append(pnl);i=j+20;break
                if price>=tp_:pnl=(tp_-entry)/entry-2*FEE;trades.append(pnl);i=j+20;break
            else:
                if price<best:best=price
                s=min(entry+stop*atr,best+trail*atr);tp_=entry-tp*atr
                if price>=s:pnl=(entry-s)/entry-2*FEE;trades.append(pnl);i=j+20;break
                if price<=tp_:pnl=(entry-tp_)/entry-2*FEE;trades.append(pnl);i=j+20;break
        else:i+=1
    if not trades:return {'t':0,'w':0,'wr':0,'ret':0,'maxdd':0,'filters':fl}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100,'filters':fl}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','FILUSDT','WLDUSDT','XLMUSDT','INJUSDT','SUIUSDT','DOGEUSDT','NEARUSDT','AAVEUSDT']

# 方案对比
SCHEMES=[
    ('原版(突破追单)',lambda c,i:entry_original(c,i),0),
    ('方案3(涨幅>20%过滤)',lambda c,i:entry_filter(c,i,20),0),
    ('方案4(回调EMA20介入)',lambda c,i:entry_pullback(c,i),0),
]

print('═══ 方案4: 回调介入 回测对比 ═══')
print('═══ 12币种, 4h, ~208天, 止损0.8ATR ═══\n')
for name,entryf,_ in SCHEMES:
    agg_t=agg_w=agg_ret=0;agg_md=0;agg_f=0
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',5)
            if len(kl)<600:continue
            r=backtest(kl,entryf)
            agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);agg_f+=r['filters']
        except:pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f'{name:28} {agg_t:4}笔 胜率{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 过滤{agg_f}')

print()
print('═══ 方案4回调介入: 若回报/回撤明显优于方案3则考虑, 否则保持方案3 ═══')
