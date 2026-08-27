#!/usr/bin/env python3
"""4h趋势波段策略: 止盈止损参数调优回测
开仓(固定): 4h EMA7>25>99多排+破60前高+动量>1% 做多 / 空排+破前低 做空 (仿trend-band entrySignal)
出场(对比): 两阶段锁利方案, 调优 stopMul/tpMul/trailMul/lockProfitPct/lockTrailPct
币: 当前持仓池8币 | 12个月4h | 费0.1%
"""
import urllib.request,json,time,math,sys

UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005

def get_k(sym,pages):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval=4h&limit=1000'
        if et:url+=f'&endTime={et}'
        req=urllib.request.Request(url,headers=UA)
        ok=False
        for a in range(3):
            try:
                b=json.loads(urllib.request.urlopen(req,timeout=15).read().decode());ok=True;break
            except: time.sleep(0.3)
        if not ok:break
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.05)
    data.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def ema_at(c,i,p):
    if i<p: return None
    k=2/(p+1); e=c[i-p+1]
    for x in range(i-p+2,i+1): e=c[x]*k+e*(1-k)
    return e

def atr_at(h,l,c,i,n=14):
    if i<n: return 0
    trs=[]
    for j in range(i-n,i+1):
        trs.append(max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])))
    return sum(trs)/len(trs)

def trend_open(c,i):
    """4h趋势波段开仓(EMA排列+破60前高/低+动量1%)"""
    if i<100: return 'NONE'
    e7=ema_at(c,i,7);e25=ema_at(c,i,25);e99=ema_at(c,i,99);e50=ema_at(c,i,50)
    if None in (e7,e25,e99,e50): return 'NONE'
    price=c[i]
    if e7>e25 and e25>e99:
        hi60=max(c[max(0,i-60):i]); mom=(price-e50)/(e50 or 1)
        if price>hi60 and mom>0.01: return 'LONG'
    elif e7<e25 and e25<e99:
        lo60=min(c[max(0,i-60):i]); mom=(price-e50)/(e50 or 1)
        if price<lo60 and mom<-0.01: return 'SHORT'
    return 'NONE'

def backtest(kl, cfg):
    """cfg: {stopMul, tpMul, trailMul, lockProfitPct, lockTrailPct}"""
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]
    n=len(c); trades=[]; i=130
    sm=cfg['stopMul']; tm=cfg['tpMul']; trm=cfg['trailMul']; lp=cfg['lockProfitPct']; lt=cfg['lockTrailPct']
    while i<n-1:
        sig=trend_open(c,i)
        if sig=='NONE': i+=1; continue
        entry=c[i]; best=entry; closed=None
        for j in range(i+1,min(i+400,n)):  # maxBars
            p=c[j]; a=atr_at(h,l,c,j) or 1
            if sig=='LONG':
                if p>best: best=p
                pnl_pct=(p-entry)/entry*100
                if pnl_pct>=lp: stop=best*(1-lt/100)
                else:
                    trail=best-trm*a; init=entry-sm*a
                    stop=max(init,trail)
                tp=entry+tm*a
                if p<=stop: closed=((p-entry)/entry); break
                if p>=tp: closed=((tp-entry)/entry); break
            else:
                if p<best: best=p
                pnl_pct=(entry-p)/entry*100
                if pnl_pct>=lp: stop=best*(1+lt/100)
                else:
                    trail=best+trm*a; init=entry+sm*a
                    stop=min(init,trail)
                tp=entry-tm*a
                if p>=stop: closed=((entry-p)/entry); break
                if p<=tp: closed=((entry-tp)/entry); break
        if closed is None: i+=1
        else:
            net=closed-2*FEE
            trades.append((j,net)); i=j+1
    if not trades:
        return {'t':0,'wr':0,'ret':0.0,'maxdd':0.0,'avgWin':0,'avgLoss':0}
    wins=[t for _,t in trades if t>0]; losses=[t for _,t in trades if t<=0]
    eq=1.0;pk=1.0;md=0.0
    for _,t in trades: eq*=(1+t);pk=max(pk,eq);dd=(pk-eq)/pk;md=max(md,dd)
    return {'t':len(trades),
            'wr':round(len(wins)/len(trades)*100,1),
            'ret':round(sum(t for _,t in trades)*100,2),
            'maxdd':round(md*100,2),
            'avgWin':round(sum(wins)/len(wins)*100,2) if wins else 0,
            'avgLoss':round(sum(losses)/len(losses)*100,2) if losses else 0}

SYMS=['BTCUSDT','SOLUSDT','APTUSDT','JUPUSDT','ADAUSDT','DOGEUSDT','TAOUSDT','1000PEPEUSDT']
P4=64

# 参数网格: 当前 vs 更大止损/更高止盈/更宽锁利
CFGS=[
  ('当前(0.8/2/0.7/2%/1%)', {'stopMul':0.8,'tpMul':2.0,'trailMul':0.7,'lockProfitPct':2.0,'lockTrailPct':1.0}),
  ('宽损(1.2/2/0.7/2%/1%)', {'stopMul':1.2,'tpMul':2.0,'trailMul':0.7,'lockProfitPct':2.0,'lockTrailPct':1.0}),
  ('高止盈(0.8/3/0.7/3%/1%)', {'stopMul':0.8,'tpMul':3.0,'trailMul':0.7,'lockProfitPct':3.0,'lockTrailPct':1.0}),
  ('让利(0.8/5/0.9/3%/1.2%)', {'stopMul':0.8,'tpMul':5.0,'trailMul':0.9,'lockProfitPct':3.0,'lockTrailPct':1.2}),
  ('保利(1.2/3/0.7/2%/0.8%)', {'stopMul':1.2,'tpMul':3.0,'trailMul':0.7,'lockProfitPct':2.0,'lockTrailPct':0.8}),
]

def main():
    print('═══ 4h趋势波段止盈止损参数调优回测 ═══',flush=True)
    print('═══ 币: 持仓池8币 | 12个月4h | 费0.1% ═══\n',flush=True)
    bars={}
    for sym in SYMS:
        try:
            kl=get_k(sym,P4)
            if len(kl)>300: bars[sym]=kl; print(f'  载入 {sym}: {len(kl)}根',flush=True)
        except Exception as e: print(f'  {sym}失败 {e}',flush=True)
    print(f'\n共载入 {len(bars)}币\n',flush=True)
    header='  {:<26}'.format('配置')
    for name,_ in CFGS: header+=f' | {name.split("(")[0][:6]}'
    print('  配置       | 笔数/胜率/累加回报/最大回撤',flush=True)
    for name,cfg in CFGS:
        agg={'t':0,'w':0,'ret':0.0,'md':0.0}
        for sym,kl in bars.items():
            r=backtest(kl,cfg)
            agg['t']+=r['t'];agg['w']+=int(r['wr']*r['t']/100);agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
        print(f'  {name:<26} {agg["t"]:5}笔 胜{wr:4.1f}% 回报{agg["ret"]:+8.1f}% 回撤{agg["md"]:5.1f}%',flush=True)

main()
