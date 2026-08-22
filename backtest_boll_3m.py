#!/usr/bin/env python3
"""布林策略回测(3个月): 放宽4h趋势过滤阈值对比
5分钟K线, 拉取3个月(约13000根), 对比不同阈值
"""
import urllib.request,json,time,math

UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005

def get_k(sym,iv,pages=14):
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
        data=b+data;et=str(b[0][0]);time.sleep(0.08)
    data.sort(key=lambda x:x[0])
    return [(x[0],float(x[4])) for x in data]  # (ts, close)

def _ema_at(values,i,n):
    if i<n:return None
    k=2/(n+1);e=values[i-n+1]
    for x in range(i-n+2,i+1):e=values[x]*k+e*(1-k)
    return e

def _atr(closes,n=14):
    trs=[]
    for i in range(1,len(closes)):
        h=max(closes[max(0,i-4):i+1]);l=min(closes[max(0,i-4):i+1]);pc=closes[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs[-n:])/n if len(trs)>=n else None

def backtest_boll(kl5, threshold, stop=0.8):
    c5=[x[1] for x in kl5]
    trades=[]; fl=0; i=130
    while i<len(c5)-3:
        price=c5[i]
        if i<20:i+=1;continue
        seg=c5[i-20:i];mid=sum(seg)/20
        sd=math.sqrt(sum((x-mid)**2 for x in seg)/20)
        upper,lower=mid+2*sd,mid-2*sd
        sig=None
        if price<=lower:sig='LONG'
        elif price>=upper:sig='SHORT'
        if not sig:i+=1;continue
        # 4h趋势过滤(用5m EMA近似, 5m*48≈4h但用EMA25差近似)
        e7=_ema_at(c5,i,7);e25=_ema_at(c5,i,25)
        spread=abs(e7-e25)/(e25 or 1)*100
        if spread>threshold:fl+=1;i+=1;continue
        entry=price;best=entry;closed=None
        for j in range(i+1,min(i+2000,len(c5))):
            p=c5[j];atr=_atr(c5[max(0,j-14):j+1]) or 1
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
    if not trades:return {'t':0,'w':0,'wr':0,'ret':0,'maxdd':0,'filters':fl}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100,'filters':fl}

# 用较少币种避免太慢(每个3个月5m数据约13页)
SYMS=['BTCUSDT','ETHUSDT','SOLUSDT']
THRESHOLDS=[1.5,2.5,3.5]

print('═══ 布林策略回测(3个月, 5分钟): 放宽趋势阈值对比 ═══')
print('═══ 3币(BTC/ETH/SOL), 3个月, 费0.1% ═══\n')

for th in THRESHOLDS:
    agg_t=agg_w=agg_ret=0;agg_md=0;agg_f=0
    for sym in SYMS:
        try:
            kl5=get_k(sym,'5m',14)
            days=len(kl5)/(24*12)
            if len(kl5)<2000:continue
            r=backtest_boll(kl5,th)
            agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);agg_f+=r['filters']
        except Exception as e:
            pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"阈值{th}% (3个月)        {agg_t:4}笔 胜{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 过滤{agg_f}")
