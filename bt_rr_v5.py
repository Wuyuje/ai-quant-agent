import sys; sys.path.insert(0,'.')
from bt_range_v8 import get_k, atr_calc, adx_calc, rsi, bb, bw_series, supertrend

def bt2(sym, kl, cfg):
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
            # v5止盈: 触对轨 + 阈值
            if pos['side']=='LONG' and price>=bbv['upper']: why='TP-对轨'
            elif pos['side']=='SHORT' and price<=bbv['lower']: why='TP-对轨'
            elif pct>=cfg['tp']: why='TP'
            # 中轨保底(浮盈>0)
            elif pos['side']=='LONG' and price<=bbv['mid'] and pct>0: why='TP-中轨'
            elif pos['side']=='SHORT' and price>=bbv['mid'] and pct>0: why='TP-中轨'
            # 止损
            elif atrs[i] and abs(price-ep)>=cfg['slatr']*atrs[i]: why='ATR-SL'
            elif roi<=-cfg['maxloss']: why='MAX-SL'
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
    return tot,wr,round(psum,1)

POOL=['NEARUSDT','SOLUSDT','ETHUSDT']
print("═══ 止盈止损优化回测 v5 (核心3币, 5m, 5x) ═══")
CFGS=[
 dict(tag='旧: tp2% 触中轨', tp=2.0, slatr=2.0, maxloss=10, maxbars=30),
 dict(tag='新: tp3.5% 触对轨', tp=3.5, slatr=2.0, maxloss=8, maxbars=40),
 dict(tag='新: tp4% 触对轨', tp=4.0, slatr=2.0, maxloss=8, maxbars=40),
]
base=dict(iv='5m', maxadx=25, maxbw=3.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68)
for c in CFGS:
    cfg=dict(base); cfg.update({k:v for k,v in c.items() if k!='tag'})
    tt=tw=tr=0; det=[]
    for s in POOL:
        kl=get_k(s,'5m',8)
        if len(kl)<120: continue
        t,wr,r=bt2(s,kl,cfg)
        tt+=t; tr+=r; tw+=round(t*wr/100); det.append(f"{s[:4]}:{r:+.0f}")
    wr=round(tw/tt*100,1) if tt else 0
    print(f"  {c['tag']:18s}: {tt:3d}笔 胜{wr:5.1f}% 回报{tr:+7.1f}% {'🟢' if tr>0 else '🔴'} [{' '.join(det)}]")
