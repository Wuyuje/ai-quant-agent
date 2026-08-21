#!/usr/bin/env python3
import urllib.request,json,time,math

UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005

def get_k(sym,iv,pages=3):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et:url+=f'&endTime={et}'
        req=urllib.request.Request(url,headers=UA)
        b=json.loads(urllib.request.urlopen(req,timeout=12).read().decode())
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.15)
    data.sort(key=lambda x:x[0])
    return [float(x[4]) for x in data]

def _ema(l,n):
    k=2/(n+1);e=l[0]
    for i in range(1,len(l)):e=l[i]*k+e*(1-k)
    return e

def _atr(closes, n=14):
    trs=[]
    for i in range(1,len(closes)):
        h=max(closes[max(0,i-5):i+1])
        l=min(closes[max(0,i-5):i+1])
        pc=closes[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    if len(trs)<n:return None
    return sum(trs[-n:])/n

def entry_signal(closes,i,lookback=60):
    if i<lookback+99: return None
    e7=_ema(closes[:i+1],7); e25=_ema(closes[:i+1],25); e99=_ema(closes[:i+1],99)
    if e7>e25 and e25>e99: d='UP'
    elif e7<e25 and e25<e99: d='DOWN'
    else: d='FLAT'
    if d=='FLAT': return None
    price=closes[i]
    if d=='UP':
        hi=max(closes[max(0,i-lookback):i])
        mom=(price-_ema(closes[:i+1],50))/(_ema(closes[:i+1],50) or 1)
        if price>hi and mom>0.01: return 'LONG'
    elif d=='DOWN':
        lo=min(closes[max(0,i-lookback):i])
        mom=(price-_ema(closes[:i+1],50))/(_ema(closes[:i+1],50) or 1)
        if price<lo and mom<-0.01: return 'SHORT'
    return None

def backtest(closes, stop_atr, tp_atr, trail_atr, lock_profit_pct, lock_trail_pct):
    """两阶段移动止盈:
    - 未盈利到lock_profit_pct时, 用trail_atr管理
    - 盈利达lock_profit_pct后, 切换到更紧的lock_trail_pct锁利
    """
    trades=[];i=160
    while i<len(closes)-5:
        sig=entry_signal(closes,i)
        if not sig:i+=1;continue
        entry=closes[i]; best=entry; locked=False
        for j in range(i+1,min(i+3000,len(closes))):
            price=closes[j]
            atr=_atr(closes[max(0,j-14):j+1]) or 1
            if sig=='LONG':
                if price>best:best=price
                pnl_pct=(price-entry)/entry*100
                # 切换锁利模式
                if pnl_pct>=lock_profit_pct: locked=True
                if locked:
                    stop=best*(1-lock_trail_pct/100)  # 极紧锁利
                else:
                    stop=max(entry-stop_atr*atr, best-trail_atr*atr)
                tp=entry+tp_atr*atr
                if price<=stop:
                    pnl=(stop-entry)/entry-2*FEE; trades.append(pnl);i=j+20;break
                if price>=tp:
                    pnl=(tp-entry)/entry-2*FEE; trades.append(pnl);i=j+20;break
            else:
                if price<best:best=price
                pnl_pct=(entry-price)/entry*100
                if pnl_pct>=lock_profit_pct: locked=True
                if locked:
                    stop=best*(1+lock_trail_pct/100)
                else:
                    stop=min(entry+stop_atr*atr, best+trail_atr*atr)
                tp=entry-tp_atr*atr
                if price>=stop:
                    pnl=(entry-stop)/entry-2*FEE; trades.append(pnl);i=j+20;break
                if price<=tp:
                    pnl=(entry-tp)/entry-2*FEE; trades.append(pnl);i=j+20;break
        else: i+=1
    if not trades: return None
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','SUIUSDT']
# 当前方案(纯ATR)
PARAMS_CURRENT={'stop':0.8,'tp':3,'trail':1.0,'lock':999,'lockTrail':1,'name':'当前(纯ATR: 0.8/3/1.0)'}
# 两阶段方案
PARAMS_TWO_STAGE=[
    {'stop':0.8,'tp':3,'trail':1.0,'lock':1.0,'lockTrail':0.5,'name':'方案A(盈利1%→回撤0.5%锁)'},
    {'stop':0.8,'tp':2.5,'trail':1.0,'lock':0.8,'lockTrail':0.3,'name':'方案B(盈利0.8%→回撤0.3%锁)'},
    {'stop':0.6,'tp':2,'trail':0.7,'lock':0.5,'lockTrail':0.2,'name':'方案C(盈利0.5%→回撤0.2%锁)'},
]

print('═══ 趋势策略回测: 当前方案 vs 两阶段锁利方案 ═══')
print('═══ 周期=15分钟, 历史≈125天, 手续费=0.1% ═══\n')
all_params=[PARAMS_CURRENT]+PARAMS_TWO_STAGE
for p in all_params:
    agg_t=agg_w=agg_ret=0; agg_maxdd=0
    for sym in SYMS:
        try:
            kl=get_k(sym,'15m',3)
            if len(kl)<500: continue
            r=backtest(kl,p['stop'],p['tp'],p['trail'],p['lock'],p['lockTrail'])
            if r:
                agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_maxdd=min(agg_maxdd,r['maxdd'])
        except: pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"{p['name']:40} {agg_t:3}笔 胜率{wr:2}% 总回报{agg_ret:+6.1f}% 回撤{agg_maxdd:.1f}%")

best=max([(k,v) for k,v in [(p['name'],{}) for p in all_params]], key=lambda x:0)  # just for printing
print()
print('═══ 两阶段锁利: 盈利达到阈值后切换更紧的移动止盈, 快速锁利 ═══')
