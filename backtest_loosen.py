#!/usr/bin/env python3
"""放开开仓条件回测: 对比原版 vs 放宽动量/突破/涨幅过滤"""
import urllib.request,json,time,math

UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005

def get_k(sym,iv,pages=4):
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

def entry_signal(closes,i,cfg):
    """cfg: {mom_pct, break_look, gain_filter}"""
    look=cfg['break_look']; mom_pct=cfg['mom_pct']; gain_f=cfg['gain_filter']
    if i<look+110:return None
    e7=_ema_at(closes,i,7);e25=_ema_at(closes,i,25);e99=_ema_at(closes,i,99)
    if e7 is None or e25 is None or e99 is None:return None
    if e7>e25 and e25>e99:d='UP'
    elif e7<e25 and e25<e99:d='DOWN'
    else:return None
    price=closes[i]
    e50=_ema_at(closes,i,50) or price
    mom=(price-e50)/e50*100
    if d=='UP':
        hi=max(closes[max(0,i-look):i])
        if price>hi and mom>mom_pct:
            g20=(price-closes[max(0,i-20)])/closes[max(0,i-20)]*100
            if g20>gain_f:return 'FILTER'
            return 'LONG'
    elif d=='DOWN':
        lo=min(closes[max(0,i-look):i])
        if price<lo and mom<-mom_pct:
            g20=(closes[max(0,i-20)]-price)/closes[max(0,i-20)]*100
            if g20>gain_f:return 'FILTER'
            return 'SHORT'
    return None

def backtest(closes,cfg,stop=0.8,tp=2.0,trail=0.7):
    trades=[];fl=0;i=170
    while i<len(closes)-5:
        sig=entry_signal(closes,i,cfg)
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

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','SUIUSDT','WLDUSDT']

CONFIGS=[
    {'name':'原版(动量1%破60高20%过滤)','mom_pct':1.0,'break_look':60,'gain_filter':20},
    {'name':'放宽动量(0.5%动)','mom_pct':0.5,'break_look':60,'gain_filter':20},
    {'name':'放宽突破(破20高)','mom_pct':1.0,'break_look':20,'gain_filter':20},
    {'name':'放宽过滤(30%涨幅)','mom_pct':1.0,'break_look':60,'gain_filter':30},
    {'name':'全放宽(动0.5破20高滤30)','mom_pct':0.5,'break_look':20,'gain_filter':30},
]

print('═══ 放开开仓条件回测(8币, 4h, ~166天, 费0.1%) ═══\n')
for cfg in CONFIGS:
    agg_t=agg_w=agg_ret=0;agg_md=0;agg_f=0
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',4)
            if len(kl)<600:continue
            r=backtest(kl,cfg)
            agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);agg_f+=r['filters']
        except:pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"{cfg['name']:30} {agg_t:4}笔 胜{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 过滤{agg_f}")
