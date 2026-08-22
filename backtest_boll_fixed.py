#!/usr/bin/env python3
"""布林策略回测(干净修正版): 4h级别 + 完整逻辑
盈亏用真实价格%计算(不用错误的放大公式)
止损: 价格反向0.8ATR 或 最大不利>=6%(核心风控)
止盈: 浮盈>1%触中轨
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

def backtest(c, threshold=3.0, open_pct=0.99, release_pct=0.98):
    trades=[];skip_trend=0;skip_band=0;i=130
    while i<len(c)-3:
        price=c[i]
        if i<20:i+=1;continue
        seg=c[i-20:i];mid=sum(seg)/20
        sd=math.sqrt(sum((x-mid)**2 for x in seg)/20)
        upper,lower=mid+2*sd,mid-2*sd
        cur_width=(upper-lower)/(mid or 1)
        width_pct=0.5
        if i>=120:
            ws=[]
            for j in range(i-100,i):
                s=c[j-20:j];m=sum(s)/20;d=math.sqrt(sum((x-m)**2 for x in s)/20)
                if m>0:ws.append(4*d/m)
            if ws:width_pct=sum(1 for w in ws if w<cur_width)/len(ws)
        # 带宽门禁(分位<98%解禁)
        if width_pct>release_pct:skip_band+=1;i+=1;continue
        # 4h趋势过滤(EMA差>3%禁开)
        e7=_ema_at(c,i,7);e25=_ema_at(c,i,25)
        if e7 is None or e25 is None:i+=1;continue
        spread=abs(e7-e25)/(e25 or 1)*100
        if spread>threshold:skip_trend+=1;i+=1;continue
        # 触轨信号
        sig=None
        if price<=lower:sig='LONG'
        elif price>=upper:sig='SHORT'
        if not sig:i+=1;continue
        # 持仓管理
        entry=price;best=entry;closed=None
        for j in range(i+1,min(i+2000,len(c))):
            p=c[j]
            atr=_atr(c[max(0,j-14):j+1]) or 1
            pnl_pct=(p-entry)/entry*100 if sig=='LONG' else (entry-p)/entry*100
            # 止损: 反向0.8ATR(价格%)
            if sig=='LONG':
                if p>best:best=p
                stop=entry-0.8*atr
                trail=best-0.7*atr
                s=max(stop,trail)
                if p<=s:
                    pnl=(s-entry)/entry*100
                    closed=pnl/100-2*FEE;i=j+20;break
                # 止盈: 触中轨+浮盈>1%
                seg2=c[j-20:j];m2=sum(seg2)/20
                if p>=m2 and pnl_pct>1:
                    closed=pnl_pct/100-2*FEE;i=j+20;break
            else:
                if p<best:best=p
                stop=entry+0.8*atr
                trail=best+0.7*atr
                s=min(stop,trail)
                if p>=s:
                    pnl=(entry-s)/entry*100
                    closed=pnl/100-2*FEE;i=j+20;break
                seg2=c[j-20:j];m2=sum(seg2)/20
                if p<=m2 and pnl_pct>1:
                    closed=pnl_pct/100-2*FEE;i=j+20;break
        if closed is None:i+=1
        else:trades.append(closed)
    if not trades:return {'t':0,'w':0,'wr':0,'ret':0,'maxdd':0,'skip_t':skip_trend,'skip_b':skip_band}
    wins=sum(1 for t in trades if t>0)
    eq=1.0;pk=1.0;md=0.0
    for t in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(trades)*100,'maxdd':md*100,'skip_t':skip_trend,'skip_b':skip_band}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','SUIUSDT','WLDUSDT','LTCUSDT','NEARUSDT','ADAUSDT','XRPUSDT']

print('═══ 布林策略回测(修正版): 4h级别+放宽过滤 ═══')
print('═══ 12币, 4h, ~3个月(6页2360根), 费0.1% ═══\n')
# 对比: 原5m严格 vs 修改后4h放宽
for label,iv,pg,th,op,rp in [
    ('修改后(4h,趋势3%,带宽98%)','4h',6,3.0,0.99,0.98),
    ('更严格(4h,趋势1.5%,带宽90%)','4h',6,1.5,0.90,0.85),
]:
    agg_t=agg_w=agg_ret=0;agg_md=0;st=sb=0
    for sym in SYMS:
        try:
            c=get_k(sym,iv,pg)
            if len(c)<600:continue
            r=backtest(c,th,op,rp)
            agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd']);st+=r['skip_t'];sb+=r['skip_b']
        except:pass
    wr=agg_w*100//agg_t if agg_t else 0
    print(f"{label:38} {agg_t:4}笔 胜{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 趋势禁{st} 带宽禁{sb}")
