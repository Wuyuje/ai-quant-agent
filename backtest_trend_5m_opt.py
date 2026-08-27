#!/usr/bin/env python3
"""5m趋势波段(trend-band两阶段锁利)参数调优回测
验证: 5m级别趋势策略改成trendBand逻辑后, 各参数组合的真实效果(止损/止盈/突破窗口/动量)
币: BTC/SOL/APT/JUP/ADA/DOGE 6币 | 1个月5m | 费0.1%
"""
import urllib.request,json,time,math,sys
UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005

def get_k(sym,pages):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval=5m&limit=1000'
        if et:url+=f'&endTime={et}'
        req=urllib.request.Request(url,headers=UA)
        ok=False
        for a in range(3):
            try:
                b=json.loads(urllib.request.urlopen(req,timeout=15).read().decode());ok=True;break
            except: time.sleep(0.3)
        if not ok:break
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.04)
    data.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def ema_at(c,i,p):
    if i<p: return None
    k=2/(p+1);e=c[i-p+1]
    for x in range(i-p+2,i+1): e=c[x]*k+e*(1-k)
    return e

def atr_at(h,l,c,i,n=14):
    if i<n: return 0
    trs=[]
    for j in range(i-n,i+1):
        trs.append(max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])))
    return sum(trs)/len(trs)

def trend_open(c,i,lb):
    if i<200: return 'NONE'
    e7=ema_at(c,i,7);e25=ema_at(c,i,25);e99=ema_at(c,i,99);e50=ema_at(c,i,50)
    if None in (e7,e25,e99,e50): return 'NONE'
    price=c[i]; mom=(price-e50)/(e50 or 1)
    if e7>e25 and e25>e99:
        if price>max(c[max(0,i-lb):i]) and mom>0.01: return 'LONG'
    elif e7<e25 and e25<e99:
        if price<min(c[max(0,i-lb):i]) and mom<-0.01: return 'SHORT'
    return 'NONE'

def backtest(kl,cfg):
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]
    n=len(c); trades=[]; i=200
    sm=cfg['stopMul']; tm=cfg['tpMul']; lb=cfg['lookback']; lp=cfg['lockP']; lt=cfg['lockT']
    while i<n-1:
        sig=trend_open(c,i,lb)
        if sig=='NONE': i+=1; continue
        entry=c[i]; best=entry; closed=None
        for j in range(i+1,min(i+300,n)):
            p=c[j]; a=atr_at(h,l,c,j) or 0.0001
            if sig=='LONG':
                if p>best: best=p
                pnl_pct=(p-entry)/entry*100
                if pnl_pct>=lp: stop=best*(1-lt/100)
                else: stop=max(entry-sm*a,best-(sm*0.7)*a)
                tp=entry+tm*a
                if p<=stop or p>=tp: closed=(p-entry)/entry; break
            else:
                if p<best: best=p
                pnl_pct=(entry-p)/entry*100
                if pnl_pct>=lp: stop=best*(1+lt/100)
                else: stop=min(entry+sm*a,best+(sm*0.7)*a)
                tp=entry-tm*a
                if p>=stop or p<=tp: closed=(entry-p)/entry; break
        if closed is None: i+=1
        else: trades.append((j,closed-2*FEE)); i=j+1
    if not trades: return {'t':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=[t for _,t in trades if t>0]
    eq=1.0;pk=1.0;md=0.0
    for _,t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),'wr':round(len(wins)/len(trades)*100,1),
            'ret':round(sum(t for _,t in trades)*100,2),'maxdd':round(md*100,2)}

SYMS=['BTCUSDT','SOLUSDT','APTUSDT','JUPUSDT','DOGEUSDT','ADAUSDT']
CFGS=[
  ('4h沿用(0.8损/5止/60破)',{'stopMul':0.8,'tpMul':5.0,'lookback':60,'lockP':3.0,'lockT':1.2}),
  ('紧损(0.4损/5止/30破)',{'stopMul':0.4,'tpMul':5.0,'lookback':30,'lockP':2.0,'lockT':0.8}),
  ('宽损(1.5损/8止/40破)',{'stopMul':1.5,'tpMul':8.0,'lookback':40,'lockP':2.0,'lockT':1.0}),
  ('5m适配(0.5损/6止/20破)',{'stopMul':0.5,'tpMul':6.0,'lookback':20,'lockP':1.5,'lockT':0.6}),
]
def main():
    print('═══ 5m趋势波段(两阶段锁利)参数调优回测 ═══',flush=True)
    print('═══ 币:6币 | 1个月5m | 费0.1% ═══\n',flush=True)
    bars={}
    for sym in SYMS:
        try:
            kl=get_k(sym,9)  # 1个月5m≈8640根≈9页
            if len(kl)>3000: bars[sym]=kl; print(f'  载入 {sym}: {len(kl)}根',flush=True)
        except Exception as e: print(f'  {sym}失败',flush=True)
    print(f'\n共载入 {len(bars)}币\n',flush=True)
    for name,cfg in CFGS:
        agg={'t':0,'w':0,'ret':0.0,'md':0.0}
        for sym,kl in bars.items():
            r=backtest(kl,cfg)
            agg['t']+=r['t'];agg['w']+=int(r['wr']*r['t']/100);agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
        print(f'  {name:<24} {agg["t"]:5}笔 胜{wr:4.1f}% 回报{agg["ret"]:+8.1f}% 回撤{agg["md"]:5.1f}%',flush=True)
main()
