#!/usr/bin/env python3
"""趋势策略高位过滤优化回测: 更精准只拦极端追高
方案C: 试位置>90%、位置+涨幅组合, 尽量保留正常突破
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
        data=b+data;et=str(b[0][0]);time.sleep(0.06)
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
        h=max(c[max(0,i-4):i+1]);l=min(c[max(0,i-4):i+1]);pc=c[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs[-n:])/n if len(trs)>=n else None

def entry_signal(c,i,cfg):
    look=60;mom_pct=1.0
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
        if price>hi and mom>mom_pct:
            # cfg: {'pos_thresh':None=不启用, 'pos_pct':None, 'gain_thresh':None, 'mode':'pos'/'combo'}
            if cfg['mode']=='pos' and pos20>cfg['pos_thresh']:
                return 'FILTER'
            if cfg['mode']=='combo' and pos20>cfg['pos_thresh'] and abs(g20)>cfg['gain_thresh']:
                return 'FILTER'
            return 'LONG'
    elif d=='DOWN':
        lo=min(c[max(0,i-look):i])
        if price<lo and mom<-mom_pct:
            return 'SHORT'
    return None

def backtest(c,cfg,stop=0.8,tp=2.0,trail=0.7):
    trades=[];fl=0;i=170
    while i<len(c)-5:
        sig=entry_signal(c,i,cfg)
        if sig is None:i+=1;continue
        if sig=='FILTER':fl+=1;i+=1;continue
        entry=c[i];best=entry
        for j in range(i+1,min(i+3000,len(c))):
            price=c[j];atr=_atr(c[max(0,j-14):j+1]) or 1
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

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','SUIUSDT','INJUSDT','WLDUSDT','LTCUSDT','NEARUSDT','ADAUSDT','XRPUSDT','UNIUSDT']

print('═══ 趋势策略高位过滤优化(方案C) ═══')
print('═══ 14币, 4h, 3个月, 费0.1% ═══\n')

VERSIONS=[
    ('原版(无过滤)',{'mode':'none'}),
    ('位置>90%过滤',{'mode':'pos','pos_thresh':90}),
    ('位置>95%过滤',{'mode':'pos','pos_thresh':95}),
    ('组合:位置>85%且涨幅>15%',{'mode':'combo','pos_thresh':85,'gain_thresh':15}),
    ('组合:位置>90%且涨幅>15%',{'mode':'combo','pos_thresh':90,'gain_thresh':15}),
    ('组合:位置>85%且涨幅>20%',{'mode':'combo','pos_thresh':85,'gain_thresh':20}),
]
preloaded={sym:get_k(sym,'4h',6) for sym in SYMS}

for name,cfg in VERSIONS:
    agg_t=agg_w=agg_ret=0;agg_md=0;agg_f=0
    for sym in SYMS:
        c=preloaded[sym]
        if len(c)<600:continue
        r=backtest(c,cfg)
        agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);agg_f+=r['filters']
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"{name:28} {agg_t:4}笔 胜{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 过滤{agg_f}笔")
