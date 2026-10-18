import sys; sys.path.insert(0,'.')
from bt_range_v8 import get_k, atr_calc, adx_calc, rsi, bb, bw_series, supertrend

def bt(sym, kl, cfg):
    cl=[k['close'] for k in kl]; n=len(kl)
    atrs=atr_calc(kl,14); adxs=adx_calc(kl,14); bws=bw_series(cl); drs=supertrend(kl)
    pos=None; trades=[]; win=loss=0; psum=0.0; lev=cfg.get('lev',3)
    for i in range(60,n-1):
        price=cl[i]; bbv=bb(cl[:i+1])
        if not bbv: continue
        if pos:
            ep=pos['entry']; pct=((price-ep)/ep*100) if pos['side']=='LONG' else ((ep-price)/ep*100)
            roi=pct*lev; why=None
            pos['peak']=max(pos.get('peak',pct),pct)
            # 止盈方案
            if cfg['mode']=='fixed':
                if pct>=cfg['tp']: why='TP'
            elif cfg['mode']=='trail':
                # 移动止盈: 达tp门槛后回撤trail平
                if pos['peak']>=cfg['tp'] and pct<=pos['peak']-cfg['trail']: why='TRAIL'
            elif cfg['mode']=='boll':
                # 触对轨止盈
                if pos['side']=='LONG' and price>=bbv['upper']: why='对轨'
                elif pos['side']=='SHORT' and price<=bbv['lower']: why='对轨'
                elif pct>=cfg['tp']: why='TP'
            if not why:
                if atrs[i] and abs(price-ep)>=cfg['slatr']*atrs[i]: why='ATR'
                elif roi<=-cfg['maxloss']: why='MAX'
                elif i-pos['i']>=cfg['maxbars']: why='TIME'
            if why:
                net=roi-0.1*lev*2; trades.append(net); psum+=net
                if net>0: win+=1
                else: loss+=1
                pos=None
        if pos: continue
        if adxs[i] is None or adxs[i]>cfg['maxadx']: continue
        if bws[i] is None or bws[i]>cfg['maxbw']: continue
        hist=[x for x in bws[max(0,i-100):i] if x is not None]
        if hist and sum(1 for x in hist if x<bws[i])/len(hist)*100>cfg['maxbwpctl']: continue
        r=rsi(cl[:i+1],14)
        if price<=bbv['lower'] and r<cfg['rsi_lo'] and drs[i]==1: pos={'side':'LONG','entry':price,'i':i,'peak':0}
        elif price>=bbv['upper'] and r>cfg['rsi_hi'] and drs[i]==-1: pos={'side':'SHORT','entry':price,'i':i,'peak':0}
    tot=win+loss; wr=round(win/tot*100,1) if tot else 0
    return tot,wr,round(psum,1)

POOL=['ETHUSDT','DOGEUSDT','INJUSDT','UNIUSDT']
print("═══ 止盈方案优化 (15m, 4币池, 3x) ═══")
print(f"{'方案':>28} {'笔':>4} {'胜率':>6} {'回报':>7}")
CFGS=[
 dict(tag='固定2% (当前)', mode='fixed', tp=2.0, slatr=2.0, maxloss=8, maxbars=40),
 dict(tag='固定3%', mode='fixed', tp=3.0, slatr=2.0, maxloss=8, maxbars=40),
 dict(tag='固定4%', mode='fixed', tp=4.0, slatr=2.0, maxloss=8, maxbars=40),
 dict(tag='固定5%', mode='fixed', tp=5.0, slatr=2.0, maxloss=8, maxbars=50),
 dict(tag='移动: 达2%回撤0.8%', mode='trail', tp=2.0, trail=0.8, slatr=2.0, maxloss=8, maxbars=50),
 dict(tag='移动: 达2%回撤1.2%', mode='trail', tp=2.0, trail=1.2, slatr=2.0, maxloss=8, maxbars=50),
 dict(tag='移动: 达3%回撤1.0%', mode='trail', tp=3.0, trail=1.0, slatr=2.0, maxloss=8, maxbars=50),
 dict(tag='移动: 达3%回撤1.5%', mode='trail', tp=3.0, trail=1.5, slatr=2.0, maxloss=8, maxbars=50),
 dict(tag='触对轨+2%', mode='boll', tp=2.0, slatr=2.0, maxloss=8, maxbars=40),
]
base=dict(iv='15m', maxadx=25, maxbw=6.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68)
best=None
for c in CFGS:
    cfg=dict(base); cfg.update({k:v for k,v in c.items() if k!='tag'})
    tt=tw=tr=0
    for s in POOL:
        kl=get_k(s,'15m',8)
        if len(kl)<120: continue
        t,wr,r=bt(s,kl,cfg)
        tt+=t; tr+=r; tw+=round(t*wr/100)
    wr=round(tw/tt*100,1) if tt else 0
    print(f"  {c['tag']:28s} {tt:4d} {wr:5.1f}% {tr:+7.1f}% {'🟢' if tr>0 else '🔴'}")
    if best is None or tr>best[1]: best=(c['tag'],tr,wr)
print(f"\n🟢 最优: {best[0]} 回报{best[1]:+.1f}% 胜率{best[2]}%")
