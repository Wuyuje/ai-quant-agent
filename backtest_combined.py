#!/usr/bin/env python3
"""量化系统综合回测(趋势+震荡双策略组合)
模拟当前系统: 趋势策略(ma7)为主 + 震荡策略(布林)为辅
周期: 1周/1月/3月/6月/1年 (4h级别)
改动: 覆盖不同时间长度
"""
import urllib.request,json,time,math,sys

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
            time.sleep(0.2);continue
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
    # 趋势: EMA排列 + 破60高/低 + 动量
    look=60
    if i<look+110:return None
    e7=_ema_at(c,i,7);e25=_ema_at(c,i,25);e99=_ema_at(c,i,99)
    if e7 is None or e25 is None or e99 is None:return None
    if e7>e25 and e25>e99:d='UP'
    elif e7<e25 and e25<e99:d='DOWN'
    else:return None
    price=c[i];e50=_ema_at(c,i,50) or price;mom=(price-e50)/e50*100
    if d=='UP':
        hi=max(c[max(0,i-look):i])
        if price>hi and mom>1:return 'LONG'
    elif d=='DOWN':
        lo=min(c[max(0,i-look):i])
        if price<lo and mom<-1:return 'SHORT'
    return None

def boll_signal(c,i,trend_th=5.0,touch_prox=20):
    # 布林: 带宽分位<98% + 4h趋势<5% + 接近轨道20%
    if i<20:return None
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
    if width_pct>0.98:return None
    # 4h趋势
    e7=_ema_at(c,i,7);e25=_ema_at(c,i,25)
    if e7 is None or e25 is None:return None
    spread=abs(e7-e25)/(e25 or 1)*100
    if spread>trend_th:return None
    # 接近轨道
    dist_low=(price:=c[i])-lower
    dist_up=upper-price
    if dist_low<=range_w*(touch_prox/100):return 'LONG'
    if dist_up<=range_w*(touch_prox/100):return 'SHORT'
    return None

def manage(c,i,sig,stop=0.8,tp=2.0,trail=0.7):
    entry=c[i];best=entry
    for j in range(i+1,min(i+2000,len(c))):
        price=c[j];atr=_atr(c[max(0,j-14):j+1]) or 1
        if sig=='LONG':
            if price>best:best=price
            s=max(entry-stop*atr,best-trail*atr);tp_=entry+tp*atr
            if price<=s:return (s-entry)/entry-2*FEE,j+20
            if price>=tp_:return (tp_-entry)/entry-2*FEE,j+20
        else:
            if price<best:best=price
            s=min(entry+stop*atr,best+trail*atr);tp_=entry-tp*atr
            if price>=s:return (entry-s)/entry-2*FEE,j+20
            if price<=tp_:return (entry-tp_)/entry-2*FEE,j+20
    return None,None

def backtest(c,start_i,end_i):
    trades=[];i=start_i
    while i<end_i-3:
        # 先趋势, 再布林(双策略组合)
        sig=trend_signal(c,i)
        strat='trend'
        if sig is None:
            sig=boll_signal(c,i)
            strat='boll'
        if sig is None:i+=1;continue
        pnl,next_i=manage(c,i,sig)
        if pnl is None:i+=1
        else:
            trades.append((pnl,strat));i=next_i
    if not trades:return {'t':0,'w':0,'wr':0,'ret':0,'maxdd':0,'trend':0,'boll':0}
    wins=sum(1 for t,_ in trades if t>0)
    n_trend=sum(1 for _,s in trades if s=='trend')
    n_boll=sum(1 for _,s in trades if s=='boll')
    eq=1.0;pk=1.0;md=0.0
    for t,_ in trades:eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'w':wins,'wr':wins*100//len(trades),'ret':sum(t for t,_ in trades)*100,'maxdd':md*100,'trend':n_trend,'boll':n_boll}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','SUIUSDT','INJUSDT']

if __name__=='__main__':
    print('═══ 量化系统综合回测(趋势+震荡组合, 8币, 4h) ═══')
    print('═══ 预加载数据... ═══\n')
    # 预加载1年数据(4h, 约2200根=6页)
    preloaded={sym:get_k(sym,'4h',6) for sym in SYMS}
    print('数据加载完成\n')
    # 各周期: 4h = 1周42根, 1月168根, 3月504根, 6月1008根, 1年2016根
    periods=[('1周',42),('1月',168),('3月',504),('6月',1008),('1年',2200)]
    for pname,length in periods:
        agg_t=agg_w=agg_ret=0;agg_md=0;n_t=n_b=0
        for sym in SYMS:
            c=preloaded[sym]
            if len(c)<600:continue
            start_i=max(170,len(c)-length)
            r=backtest(c,start_i,len(c))
            agg_t+=r['t'];agg_w+=r['w'];agg_ret+=r['ret'];agg_md=max(agg_md,r['maxdd'])
            n_t+=r['trend'];n_b+=r['boll']
        wr=agg_w*100//agg_t if agg_t else 0
        print(f"{pname:6}({length}根) {agg_t:4}笔 胜{wr:2}% 回报{agg_ret:+7.1f}% 回撤{agg_md:5.1f}% 趋势{n_t}笔/布林{n_b}笔")
