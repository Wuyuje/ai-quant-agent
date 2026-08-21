#!/usr/bin/env python3
"""趋势策略开仓改进回测: 高位过滤+位置过滤+动量过热过滤
对比 原版 vs 改进版(3个过滤组合)
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

def _ema(l,n):
    k=2/(n+1);e=l[0]
    for i in range(1,len(l)):e=l[i]*k+e*(1-k)
    return e

def _ema_at(closes,i,n):
    if i<n:return None
    return _ema(closes[i-n+1:i+1],n)

def _atr(closes,n=14):
    trs=[]
    for i in range(1,len(closes)):
        h=max(closes[max(0,i-4):i+1]);l=min(closes[max(0,i-4):i+1]);pc=closes[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    if len(trs)<n:return None
    return sum(trs[-n:])/n

def entry_signal(closes,i,lookback=60,use_filters=False,filter_cfg=None):
    """基础信号 + 可选3个过滤"""
    if i<lookback+110:return None
    e7=_ema_at(closes,i,7);e25=_ema_at(closes,i,25);e99=_ema_at(closes,i,99)
    if e7 is None or e25 is None or e99 is None:return None
    if e7>e25 and e25>e99:d='UP'
    elif e7<e25 and e25<e99:d='DOWN'
    else:d='FLAT'
    if d=='FLAT':return None
    price=closes[i]
    if d=='UP':
        hi=max(closes[max(0,i-lookback):i])
        e50=_ema_at(closes,i,50) or price
        mom=(price-e50)/e50
        if price>hi and mom>0.01:
            # ═══ 3个高位过滤(可选) ═══
            if use_filters and filter_cfg:
                # ① 高位过滤: 价格高于EMA25超过阈值(如8%)
                hi25=(price-e25)/e25*100
                if hi25>filter_cfg['ema25_over']:
                    return 'FILTER_HI25'
                # ② 位置过滤: 20根K线位置>85%高位
                lo20=min(closes[max(0,i-19):i+1])
                hi20=max(closes[max(0,i-19):i+1])
                pos20=(price-lo20)/(hi20-lo20 or 1)*100
                if pos20>filter_cfg['pos20']:
                    return 'FILTER_POS'
                # ③ 动量过热: 近20根涨幅>15%
                g20=(price-closes[max(0,i-20)])/closes[max(0,i-20)]*100
                if g20>filter_cfg['gain20']:
                    return 'FILTER_MOM'
            return 'LONG'
    elif d=='DOWN':
        lo=min(closes[max(0,i-lookback):i])
        e50=_ema_at(closes,i,50) or price
        mom=(price-e50)/e50
        if price<lo and mom<-0.01:
            if use_filters and filter_cfg:
                lo25=(e25-price)/e25*100
                if lo25>filter_cfg['ema25_over']:
                    return 'FILTER_LO25'
                hi20=max(closes[max(0,i-19):i+1])
                lo20=min(closes[max(0,i-19):i+1])
                pos20=(price-lo20)/(hi20-lo20 or 1)*100
                if pos20<(100-filter_cfg['pos20']):
                    return 'FILTER_POS'
                g20=(closes[max(0,i-20)]-price)/closes[max(0,i-20)]*100
                if g20>filter_cfg['gain20']:
                    return 'FILTER_MOM'
            return 'SHORT'
    return None

def backtest(closes,use_filters=False,filter_cfg=None,stop=0.8,tp=2.0,trail=0.7):
    trades=[];filters=0;i=170
    while i<len(closes)-5:
        sig=entry_signal(closes,i,use_filters=use_filters,filter_cfg=filter_cfg)
        if sig is None:i+=1;continue
        if sig.startswith('FILTER'):
            filters+=1;i+=1;continue
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
    if not trades:return None
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100,'filters':filters}

# 用当前持仓/亏损相关的币 + 其他主流
SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','FILUSDT','WLDUSDT','XLMUSDT','INJUSDT','SUIUSDT','DOGEUSDT','NEARUSDT','AAVEUSDT']

# 过滤配置: 方案①+②+③组合
FILTER={
    'ema25_over':8.0,   # ①价格高于EMA25>8%不追
    'pos20':85.0,       # ②20根位置>85%高位不追
    'gain20':15.0,      # ③近20根涨幅>15%过热不追
}

print('═══ 趋势策略开仓改进回测: 原版 vs 高位过滤组合 ═══')
print('═══ 12币种, 4h级别, ~208天(5页), 手续费0.1%, 止损0.8ATR ═══\n')

CONFIGS=[
    ('原版(无过滤)',False,None),
    ('3过滤组合(EMA25>8%位置>85%涨幅>15%)',True,FILTER),
]

for name,use_filters,cfg in CONFIGS:
    agg_t=agg_w=agg_ret=0;agg_md=0;agg_f=0
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',5)
            if len(kl)<600:continue
            r=backtest(kl,use_filters,cfg)
            if r:
                agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);agg_f+=r['filters']
        except:pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f'{name:44} {agg_t:4}笔 胜率{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 过滤{agg_f}次')

print()
print('═══ 若组合胜率/回报有明显改善则采用, 否则需调整参数 ═══')
