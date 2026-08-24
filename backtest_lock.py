#!/usr/bin/env python3
"""趋势策略锁利参数回测: 对比当前激进 vs 合理 vs 中等
参数: 止损ATR / 止盈ATR / 移动ATR / 锁利阈值% / 锁利回撤%
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

def trend_signal(c,i):
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
            # 高位组合过滤(位置>80%且涨幅>20%)
            if pos20>80 and abs(g20)>20:return None
            return 'LONG'
    elif d=='DOWN':
        lo=min(c[max(0,i-look):i])
        if price<lo and mom<-1:return 'SHORT'
    return None

def backtest(c, stop_mul, tp_mul, trail_mul, lock_pct, lock_trail):
    trades=[];i=170
    while i<len(c)-5:
        sig=trend_signal(c,i)
        if sig is None:i+=1;continue
        entry=c[i];best=entry;peak_pnl=0;closed=None
        for j in range(i+1,min(i+3000,len(c))):
            p=c[j];atr=_atr(c[max(0,j-14):j+1]) or 1
            pnl_pct=(p-entry)/entry*100 if sig=='LONG' else (entry-p)/entry*100
            if sig=='LONG':
                if p>best:best=p;peak_pnl=max(peak_pnl,pnl_pct)
                # 阶段2锁利
                if pnl_pct>=lock_pct:
                    stop=best*(1-lock_trail/100)
                else:
                    stop=max(entry-stop_mul*atr,best-trail_mul*atr)
                tp=entry+tp_mul*atr
                if p<=stop:closed=pnl_pct/100-2*FEE;i=j+20;break
                if p>=tp:closed=pnl_pct/100-2*FEE;i=j+20;break
            else:
                if p<best:best=p;peak_pnl=max(peak_pnl,pnl_pct)
                if pnl_pct>=lock_pct:
                    stop=best*(1+lock_trail/100)
                else:
                    stop=min(entry+stop_mul*atr,best+trail_mul*atr)
                tp=entry-tp_mul*atr
                if p>=stop:closed=(entry-p)/entry*100/100-2*FEE;i=j+20;break
                if p<=tp:closed=pnl_pct/100-2*FEE;i=j+20;break
        if closed is None:i+=1
        else:trades.append(closed)
    if not trades:return {'t':0,'w':0,'wr':0,'ret':0,'maxdd':0}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','SUIUSDT','WLDUSDT','LTCUSDT','NEARUSDT','ADAUSDT','XRPUSDT','UNIUSDT','OPUSDT']

print('═══ 趋势策略锁利参数回测(14币,4h,3个月,费0.1%) ═══\n')
preloaded={sym:get_k(sym,'4h',6) for sym in SYMS}

# (名称, 止损, 止盈, 移动, 锁利阈值%, 锁利回撤%)
VERSIONS=[
    ('当前(止损0.8,锁利0.5/0.2)',0.8,2.0,0.7,0.5,0.2),
    ('建议1(止损0.8,锁利2/1)',0.8,2.0,0.7,2.0,1.0),
    ('建议2(止损1.2,锁利2/1)',1.2,2.0,1.0,2.0,1.0),
    ('建议3(止损1.5,锁利2.5/1.5)',1.5,2.5,1.2,2.5,1.5),
    ('建议4(止损1.0,锁利2/1.5)',1.0,2.0,1.0,2.0,1.5),
]

for name,sm,tm,trm,lp,lt in VERSIONS:
    agg_t=agg_w=agg_ret=0;agg_md=0
    for sym in SYMS:
        c=preloaded[sym]
        if len(c)<600:continue
        r=backtest(c,sm,tm,trm,lp,lt)
        agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd'])
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"{name:36} {agg_t:4}笔 胜{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}%")
