import sys; sys.path.insert(0,'.')
from bt_range_v8 import get_k, atr_calc, adx_calc, rsi, bb, bw_series, supertrend

def bt3(sym, kl, cfg):
    cl=[k['close'] for k in kl]; n=len(kl)
    atrs=atr_calc(kl,14); adxs=adx_calc(kl,14); bws=bw_series(cl); drs=supertrend(kl)
    pos=None; trades=[]; win=loss=0; psum=0.0
    lev=5
    for i in range(60,n-1):
        price=cl[i]; bbv=bb(cl[:i+1])
        if not bbv: continue
        if pos:
            ep=pos['entry']
            pct=((price-ep)/ep*100) if pos['side']=='LONG' else ((ep-price)/ep*100)
            roi=pct*lev; why=None
            # 止盈: 固定阈值
            if pct>=cfg['tp']: why='TP'
            # 移动止盈: 曾达峰值后回撤
            elif pct>cfg['tp']*0.5 and pct < (pos.get('peak',0)-cfg['trail']): why='TRAIL'
            # 止损
            elif atrs[i] and abs(price-ep)>=cfg['slatr']*atrs[i]: why='ATR'
            elif roi<=-cfg['maxloss']: why='MAX'
            elif i-pos['i']>=cfg['maxbars']: why='TIME'
            if pos: pos['peak']=max(pos.get('peak',pct),pct)
            if why:
                net=roi-0.1*lev*2
                trades.append(net); psum+=net
                if net>0: win+=1
                else: loss+=1
                pos=None
        if pos: continue
        if adxs[i] is None or adxs[i]>cfg['maxadx']: continue
        if bws[i] is None or bws[i]>cfg['maxbw']: continue
        hist=[x for x in bws[max(0,i-100):i] if x is not None]
        if hist:
            pctl=sum(1 for x in hist if x<bws[i])/len(hist)*100
            if pctl>cfg['maxbwpctl']: continue
        r=rsi(cl[:i+1],14)
        if price<=bbv['lower'] and r<cfg['rsi_lo'] and drs[i]==1: pos={'side':'LONG','entry':price,'i':i,'peak':0}
        elif price>=bbv['upper'] and r>cfg['rsi_hi'] and drs[i]==-1: pos={'side':'SHORT','entry':price,'i':i,'peak':0}
    tot=win+loss; wr=round(win/tot*100,1) if tot else 0
    # 平均盈亏比
    wins=[t for t in trades if t>0]; losses=[t for t in trades if t<=0]
    avgw=sum(wins)/len(wins) if wins else 0
    avgl=sum(losses)/len(losses) if losses else 0
    return tot,wr,round(psum,1),round(avgw,2),round(avgl,2)

POOL=['NEARUSDT','SOLUSDT','ETHUSDT']
print("═══ 优化止盈组合回测 v6 (核心3, 5m, 5x) ═══")
print(f"{'配置':>24} {'笔':>4} {'胜率':>6} {'回报':>7} {'均盈':>6} {'均亏':>6}")
CFGS=[
 dict(tag='tp2% sl2.0', tp=2.0, slatr=2.0, maxloss=8, maxbars=30, trail=99),
 dict(tag='tp3% sl2.0', tp=3.0, slatr=2.0, maxloss=8, maxbars=40, trail=99),
 dict(tag='tp4% sl2.0', tp=4.0, slatr=2.0, maxloss=8, maxbars=40, trail=99),
 dict(tag='tp5% sl2.0', tp=5.0, slatr=2.0, maxloss=8, maxbars=50, trail=99),
 dict(tag='tp3%+移动1.5 sl2', tp=3.0, slatr=2.0, maxloss=8, maxbars=40, trail=1.5),
 dict(tag='tp4%+移动2 sl2', tp=4.0, slatr=2.0, maxloss=8, maxbars=40, trail=2.0),
]
base=dict(iv='5m', maxadx=25, maxbw=3.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68)
best=None
for c in CFGS:
    cfg=dict(base); cfg.update({k:v for k,v in c.items() if k!='tag'})
    tt=tw=tr=0; aw=al=0
    for s in POOL:
        kl=get_k(s,'5m',8)
        if len(kl)<120: continue
        t,wr,r,avgw,avgl=bt3(s,kl,cfg)
        tt+=t; tr+=r; tw+=round(t*wr/100); aw=avgw; al=avgl
    wr=round(tw/tt*100,1) if tt else 0
    print(f"  {c['tag']:24s} {tt:4d} {wr:5.1f}% {tr:+7.1f}% {aw:+6.2f} {al:+6.2f} {'🟢' if tr>0 else '🔴'}")
    if best is None or tr>best[1]: best=(c['tag'],tr,wr)
print(f"\n🟢 最优: {best[0]} 回报{best[1]:+.1f}% 胜率{best[2]}%")
