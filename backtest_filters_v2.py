#!/usr/bin/env python3
"""趋势策略开仓改进回测v2: 合理阈值(只过滤极端追高)"""
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

def entry_signal(closes,i,lookback=60,filters=None):
    if i<lookback+110:return None
    e7=_ema_at(closes,i,7);e25=_ema_at(closes,i,25);e99=_ema_at(closes,i,99)
    if e7 is None or e25 is None or e99 is None:return None
    if e7>e25 and e25>e99:d='UP'
    elif e7<e25 and e25<e99:d='DOWN'
    else:return None
    price=closes[i]
    if d=='UP':
        hi=max(closes[max(0,i-lookback):i]);e50=_ema_at(closes,i,50) or price
        mom=(price-e50)/e50
        if price>hi and mom>0.01:
            if filters:
                hi25=(price-e25)/e25*100
                if 'ema25' in filters and hi25>filters['ema25']:return 'FILTER'
                g20=(price-closes[max(0,i-20)])/closes[max(0,i-20)]*100
                if 'gain20' in filters and g20>filters['gain20']:return 'FILTER'
            return 'LONG'
    elif d=='DOWN':
        lo=min(closes[max(0,i-lookback):i]);e50=_ema_at(closes,i,50) or price
        mom=(price-e50)/e50
        if price<lo and mom<-0.01:
            if filters:
                lo25=(e25-price)/e25*100
                if 'ema25' in filters and lo25>filters['ema25']:return 'FILTER'
                g20=(closes[max(0,i-20)]-price)/closes[max(0,i-20)]*100
                if 'gain20' in filters and g20>filters['gain20']:return 'FILTER'
            return 'SHORT'
    return None

def backtest(closes,filters=None,stop=0.8,tp=2.0,trail=0.7):
    trades=[];fl=0;i=170
    while i<len(closes)-5:
        sig=entry_signal(closes,i,filters=filters)
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

# 合理阈值: 只过滤极端追高(基于90%分位)
CFG=[
    ('原版(无过滤)',None),
    ('EMA25偏离>12.6%',{'ema25':12.6}),          # 90%分位
    ('20根涨幅>20%',{'gain20':20.0}),            # 90%分位
    ('EMA25>12.6% && 涨幅>20%',{'ema25':12.6,'gain20':20.0}),  # 组合
]

print('═══ 趋势策略开仓改进回测v2(合理阈值) ═══')
print('═══ 12币种, 4h, ~208天, 止损0.8ATR ═══\n')
for name,filters in CFG:
    agg_t=agg_w=agg_ret=0;agg_md=0;agg_f=0
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',5)
            if len(kl)<600:continue
            r=backtest(kl,filters)
            agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);agg_f+=r['filters']
        except:pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f'{name:30} {agg_t:4}笔 胜率{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 过滤{agg_f}')
