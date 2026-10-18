import sys; sys.path.insert(0,'.')
from bt_range_v8 import get_k, atr_calc, adx_calc, rsi, bb, bw_series, supertrend

def bt(sym, kl, cfg):
    cl=[k['close'] for k in kl]; n=len(kl)
    atrs=atr_calc(kl,14); adxs=adx_calc(kl,14); bws=bw_series(cl); drs=supertrend(kl)
    pos=None; trades=[]; win=loss=0; psum=0.0
    lev=cfg.get('lev',5)
    for i in range(60,n-1):
        price=cl[i]; bbv=bb(cl[:i+1])
        if not bbv: continue
        if pos:
            ep=pos['entry']
            pct=((price-ep)/ep*100) if pos['side']=='LONG' else ((ep-price)/ep*100)
            roi=pct*lev; why=None
            if pct>=cfg['tp']: why='TP'
            elif atrs[i] and abs(price-ep)>=cfg['slatr']*atrs[i]: why='ATR'
            elif roi<=-cfg['maxloss']: why='MAX'
            elif i-pos['i']>=cfg['maxbars']: why='TIME'
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
        if price<=bbv['lower'] and r<cfg['rsi_lo'] and drs[i]==1: pos={'side':'LONG','entry':price,'i':i}
        elif price>=bbv['upper'] and r>cfg['rsi_hi'] and drs[i]==-1: pos={'side':'SHORT','entry':price,'i':i}
    tot=win+loss; wr=round(win/tot*100,1) if tot else 0
    wins=[t for t in trades if t>0]; losses=[t for t in trades if t<=0]
    avgw=round(sum(wins)/len(wins),2) if wins else 0
    avgl=round(sum(losses)/len(losses),2) if losses else 0
    return tot,wr,round(psum,1),avgw,avgl

POOL=['NEARUSDT','SOLUSDT','ETHUSDT']
print("═══ 换周期回测 (核心3币, tp2% sl2ATR) ═══")
print(f"{'周期':>5} {'笔':>4} {'胜率':>6} {'回报':>7} {'均盈':>6} {'均亏':>6}")
for iv,tp,mb in [('5m',2.0,30),('15m',2.0,40),('30m',2.0,30),('1h',2.5,30),('2h',3.0,20),('4h',3.0,15)]:
    cfg=dict(iv=iv, maxadx=25, maxbw=6.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68, tp=tp, slatr=2.0, maxloss=8, maxbars=mb, lev=5)
    tt=tw=tr=0; aw=al=0
    for s in POOL:
        kl=get_k(s,iv,8)
        if len(kl)<120: continue
        t,wr,r,avgw,avgl=bt(s,kl,cfg)
        tt+=t; tr+=r; tw+=round(t*wr/100); aw=avgw; al=avgl
    wr=round(tw/tt*100,1) if tt else 0
    print(f"  {iv:>5} {tt:4d} {wr:5.1f}% {tr:+7.1f}% {aw:+6.2f} {al:+6.2f} {'🟢' if tr>0 else '🔴'}")
