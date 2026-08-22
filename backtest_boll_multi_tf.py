#!/usr/bin/env python3
"""布林策略回测: 不同时间级别(5m/15m/1h) + 正确4h趋势禁开逻辑
关键: 4h趋势EMA差>阈值禁开布林(趋势行情不交易), 只在准震荡行情开仓
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

def _4h_spread_at(hk, cur_ts, idx):
    """从4h数据数组, 在cur_ts时刻之前用EMA算趋势强度"""
    # 找到cur_ts之前最近的4h索引
    j=idx
    while j>=0 and hk[j][0]>=cur_ts:
        j-=1
    if j<29:return None  # 数据不足
    c=[x[1] for x in hk[:j+1]]
    e7=_ema_at(c,j,7);e25=_ema_at(c,j,25)
    if e7 is None or e25 is None:return None
    return abs(e7-e25)/(e25 or 1)*100, j

def backtest(kl, hk, threshold, trend_interval, stop=0.8):
    """kl = 交易级别K线(trade_interval), hk = 4h数据"""
    c=[x[1] for x in kl]; ts=[x[0] for x in kl]
    # 4h数据的close数组
    hc=[x[1] for x in hk]
    trades=[];skip_trend=0;skip_nodata=0;i=130
    while i<len(c)-3:
        price=c[i];cur_ts=ts[i]
        seg=c[i-20:i];mid=sum(seg)/20
        sd=math.sqrt(sum((x-mid)**2 for x in seg)/20)
        upper,lower=mid+2*sd,mid-2*sd
        sig=None
        if price<=lower:sig='LONG'
        elif price>=upper:sig='SHORT'
        if not sig:i+=1;continue
        # 4h趋势过滤: 找cur_ts对应的4h索引
        # 二分查找cur_ts在4h时间戳中的位置
        lo,hi=0,len(ts)-1
        hk_idx=None
        for hi_idx in range(len(hk)):
            if hk[hi_idx][0]<=cur_ts:
                hk_idx=hi_idx
            else:break
        if hk_idx is None or hk_idx<29:
            skip_nodata+=1;i+=1;continue  # 数据不足保守禁开
        cc=hc[:hk_idx+1]
        e7=_ema_at(cc,hk_idx,7);e25=_ema_at(cc,hk_idx,25)
        if e7 is None or e25 is None:
            skip_nodata+=1;i+=1;continue
        spread=abs(e7-e25)/(e25 or 1)*100
        if spread>threshold:
            skip_trend+=1;i+=1;continue  # 趋势行情禁开
        # 持仓管理
        entry=price;best=entry;closed=None
        for j in range(i+1,min(i+2000,len(c))):
            p=c[j];atr=_atr(c[max(0,j-14):j+1]) or 1
            if sig=='LONG':
                if p>best:best=p
                s=max(entry-stop*atr,best-0.7*atr);tp=entry+2*atr
                if p<=s:closed=(s-entry)/entry-2*FEE;i=j+20;break
                if p>=tp:closed=(tp-entry)/entry-2*FEE;i=j+20;break
            else:
                if p<best:best=p
                s=min(entry+stop*atr,best+0.7*atr);tp=entry-2*atr
                if p>=s:closed=(entry-s)/entry-2*FEE;i=j+20;break
                if p<=tp:closed=(entry-tp)/entry-2*FEE;i=j+20;break
        if closed is None:i+=1
        else:trades.append(closed)
    if not trades:return {'t':0,'w':0,'wr':0,'ret':0,'maxdd':0,'skip':skip_trend,'nodata':skip_nodata}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100,'skip':skip_trend,'nodata':skip_nodata}

# 用BTC/ETH测不同时间级别(数据量控制)
SYMS=['BTCUSDT','ETHUSDT']
# 各交易级别需要拉取的页数(3个月):
# 5m=13000根=13页, 15m=8800根=9页, 1h=2200根=3页
INTERVALS=[('5m',14),('15m',9),('1h',3)]

print('═══ 布林策略回测(3个月): 不同时间级别 + 正确4h趋势禁开 ═══')
print('═══ 逻辑: 4h趋势EMA差>1.5%禁开, 只在准震荡行情交易 ═══\n')
THRESHOLD=1.5

for iv,pg in INTERVALS:
    agg_t=agg_w=agg_ret=0;agg_md=0;agg_skip=0
    for sym in SYMS:
        try:
            kl=get_k(sym,iv,pg)
            hk=get_k(sym,'4h',60)
            if len(kl)<2000 or len(hk)<40:continue
            r=backtest(kl,hk,THRESHOLD,iv)
            agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);agg_skip+=r['skip']
        except Exception as e:pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"{iv:5} 级别        {agg_t:4}笔 胜{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 趋势禁开{agg_skip}")
