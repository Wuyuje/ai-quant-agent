#!/usr/bin/env python3
"""震荡策略不同时间级别回测: 5m/15m/1h/4h
逻辑: 接近轨道20%触发 + 趋势过滤5% + 带宽98%
对比哪个周期效果最好
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
        h=max(c[max(0,i-4):i+1]);l=min(c[max(0,i-4):i+1]);pc=c[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs[-n:])/n if len(trs)>=n else None

def backtest(c, touch_prox=20, trend_th=5.0, band_release=0.98):
    trades=[];i=130
    while i<len(c)-3:
        price=c[i]
        if i<20:i+=1;continue
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
        if width_pct>band_release:i+=1;continue
        # 趋势过滤(用当前EMA7-25差近似)
        e7=_ema_at(c,i,7);e25=_ema_at(c,i,25)
        if e7 is None or e25 is None:i+=1;continue
        spread=abs(e7-e25)/(e25 or 1)*100
        if spread>trend_th:i+=1;continue
        # 接近轨道20%
        dist_low=price-lower;dist_up=upper-price
        sig=None
        if dist_low<=range_w*(touch_prox/100):sig='LONG'
        elif dist_up<=range_w*(touch_prox/100):sig='SHORT'
        if not sig:i+=1;continue
        # 持仓管理
        entry=price;best=entry;closed=None
        for j in range(i+1,min(i+2000,len(c))):
            p=c[j];atr=_atr(c[max(0,j-14):j+1]) or 1
            pnl_pct=(p-entry)/entry*100 if sig=='LONG' else (entry-p)/entry*100
            if sig=='LONG':
                if p>best:best=p
                s=max(entry-0.8*atr,best-0.7*atr);tp=entry+2*atr
                if p<=s:closed=(s-entry)/entry-2*FEE;i=j+20;break
                if p>=tp:closed=(tp-entry)/entry-2*FEE;i=j+20;break
                seg2=c[j-20:j];m2=sum(seg2)/20
                if p>=m2 and pnl_pct>1:closed=pnl_pct/100-2*FEE;i=j+20;break
            else:
                if p<best:best=p
                s=min(entry+0.8*atr,best+0.7*atr);tp=entry-2*atr
                if p>=s:closed=(entry-s)/entry-2*FEE;i=j+20;break
                if p<=tp:closed=(entry-tp)/entry-2*FEE;i=j+20;break
                seg2=c[j-20:j];m2=sum(seg2)/20
                if p<=m2 and pnl_pct>1:closed=pnl_pct/100-2*FEE;i=j+20;break
        if closed is None:i+=1
        else:trades.append(closed)
    if not trades:return {'t':0,'w':0,'wr':0,'ret':0,'maxdd':0}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','SUIUSDT','INJUSDT']

print('═══ 震荡策略时间级别回测(8币, ~3个月, 费0.1%) ═══\n')
# 各级别拉取页数(3个月): 5m=13000根13页(取前8页近2月), 15m=8700根9页, 1h=2200根3页, 4h=550根1页
INTERVALS=[('5m',10),('15m',8),('1h',4),('4h',4)]

for iv,pg in INTERVALS:
    agg_t=agg_w=agg_ret=0;agg_md=0
    for sym in SYMS:
        try:
            c=get_k(sym,iv,pg)
            if len(c)<500:continue
            r=backtest(c)
            agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd'])
        except:pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"{iv:5} 级别     {agg_t:5}笔 胜{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}%")
