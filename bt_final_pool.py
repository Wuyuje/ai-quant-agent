import sys; sys.path.insert(0,'.')
from bt_range_v8 import get_k, atr_calc, adx_calc, rsi, bb, bw_series, supertrend

def bt(sym, kl, cfg):
    cl=[k['close'] for k in kl]; n=len(kl)
    atrs=atr_calc(kl,14); adxs=adx_calc(kl,14); bws=bw_series(cl); drs=supertrend(kl)
    pos=None; trades=[]; win=loss=0; psum=0.0; lev=3
    for i in range(60,n-1):
        price=cl[i]; bbv=bb(cl[:i+1])
        if not bbv: continue
        if pos:
            ep=pos['entry']; pct=((price-ep)/ep*100) if pos['side']=='LONG' else ((ep-price)/ep*100)
            roi=pct*lev; why=None
            if pct>=cfg['tp']: why='TP'
            elif atrs[i] and abs(price-ep)>=cfg['slatr']*atrs[i]: why='ATR'
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
        if price<=bbv['lower'] and r<cfg['rsi_lo'] and drs[i]==1: pos={'side':'LONG','entry':price,'i':i}
        elif price>=bbv['upper'] and r>cfg['rsi_hi'] and drs[i]==-1: pos={'side':'SHORT','entry':price,'i':i}
    tot=win+loss; wr=round(win/tot*100,1) if tot else 0
    return tot,wr,round(psum,1)

# 15m, 测多个候选币, 剔除亏损
CAND=['ETHUSDT','SOLUSDT','NEARUSDT','DOGEUSDT','APTUSDT','XRPUSDT','ADAUSDT','LINKUSDT','LTCUSDT','DOTUSDT','AVAXUSDT','UNIUSDT','INJUSDT','SUIUSDT','OPUSDT','ARBUSDT']
cfg=dict(iv='15m', maxadx=25, maxbw=6.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68, tp=2.0, slatr=2.0, maxloss=8, maxbars=40)
print("═══ 15m 各币盈亏(选盈利币入池) ═══")
win_coins=[]; tot_all=0
for s in CAND:
    kl=get_k(s,'15m',8)
    if len(kl)<120: continue
    t,wr,r=bt(s,kl,cfg)
    flag='🟢' if r>0 else '🔴'
    print(f"  {s:12s} {t:3d}笔 胜{wr:5.1f}% 回报{r:+7.1f}% {flag}")
    if r>0: win_coins.append(s)
    tot_all+=r
print(f"\n🟢 盈利币池({len(win_coins)}): {win_coins}")
print(f"   剔除后预期合计: {tot_all:+.1f}% (全部)")
