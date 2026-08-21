#!/usr/bin/env python3
"""趋势策略止损倍数对比回测: 4h级别, 对比0.6ATR vs 之前方案
用途: 验证用户止损修改为4h+0.6ATR后的实际表现
"""
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

def _ema(l,n):
    k=2/(n+1);e=l[0]
    for i in range(1,len(l)):e=l[i]*k+e*(1-k)
    return e

def _atr(closes,n=14):
    trs=[]
    for i in range(1,len(closes)):
        h=max(closes[max(0,i-4):i+1]);l=min(closes[max(0,i-4):i+1]);pc=closes[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    if len(trs)<n:return None
    return sum(trs[-n:])/n

def entry_signal(closes,i,lookback=60):
    if i<lookback+99:return None
    e7=_ema(closes[:i+1],7);e25=_ema(closes[:i+1],25);e99=_ema(closes[:i+1],99)
    if e7>e25 and e25>e99:d='UP'
    elif e7<e25 and e25<e99:d='DOWN'
    else:d='FLAT'
    if d=='FLAT':return None
    price=closes[i]
    if d=='UP':
        hi=max(closes[max(0,i-lookback):i]);mom=(price-_ema(closes[:i+1],50))/(_ema(closes[:i+1],50) or 1)
        if price>hi and mom>0.01:return 'LONG'
    elif d=='DOWN':
        lo=min(closes[max(0,i-lookback):i]);mom=(price-_ema(closes[:i+1],50))/(_ema(closes[:i+1],50) or 1)
        if price<lo and mom<-0.01:return 'SHORT'
    return None

def backtest(closes,stop_atr,tp_atr,trail_atr):
    trades=[];i=160
    while i<len(closes)-5:
        sig=entry_signal(closes,i)
        if not sig:i+=1;continue
        entry=closes[i];best=entry
        for j in range(i+1,min(i+3000,len(closes))):
            price=closes[j];atr=_atr(closes[max(0,j-14):j+1]) or 1
            if sig=='LONG':
                if price>best:best=price
                stop=max(entry-stop_atr*atr,best-trail_atr*atr);tp=entry+tp_atr*atr
                if price<=stop:pnl=(stop-entry)/entry-2*FEE;trades.append(pnl);i=j+20;break
                if price>=tp:pnl=(tp-entry)/entry-2*FEE;trades.append(pnl);i=j+20;break
            else:
                if price<best:best=price
                stop=min(entry+stop_atr*atr,best+trail_atr*atr);tp=entry-tp_atr*atr
                if price>=stop:pnl=(entry-stop)/entry-2*FEE;trades.append(pnl);i=j+20;break
                if price<=tp:pnl=(entry-tp)/entry-2*FEE;trades.append(pnl);i=j+20;break
        else:i+=1
    if not trades:return None
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','SUIUSDT','INJUSDT','FILUSDT','WLDUSDT']
# 对比: 当前(0.6/2/0.7) vs 之前方案C(0.8/3/1.0)
PARAMS=[
    {'name':'当前(0.6/2.0/0.7) 4h','s':0.6,'t':2.0,'tl':0.7},
    {'name':'之前(0.8/3.0/1.0) 4h','s':0.8,'t':3.0,'tl':1.0},
]

print('═══ 趋势策略止损修改回测对比(4h级别, ~166天历史, 手续费0.1%) ═══\n')
for p in PARAMS:
    agg_t=agg_w=agg_ret=0;agg_md=0
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',4)
            if len(kl)<500:continue
            r=backtest(kl,p['s'],p['t'],p['tl'])
            if r:
                agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd'])
        except:pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"{p['name']:28} {agg_t:3}笔 胜率{wr:2}% 总回报{agg_ret:+7.1f}% 最大回撤{agg_md:5.1f}%")
print()
print('═══ 8币种(含当前持仓INJ/FIL/WLD/SUI) ═══')
