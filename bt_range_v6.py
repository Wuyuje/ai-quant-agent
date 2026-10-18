import sys
sys.path.insert(0,'.')
from bt_range_v5 import get_k, bt, ema, rsi, atr_calc, adx_calc, bw_series, bb, supertrend

# 方案A参数
cfgA=dict(name='A', iv='5m', maxadx=25, maxbw=3.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68, tp=1.5, slatr=2.0, maxloss=5, maxbars=30, lev=3, use_super=True)
# 盈利币池
GOOD=['ETHUSDT','SOLUSDT','XRPUSDT','LINKUSDT','ADAUSDT','NEARUSDT']
# 全部
ALL=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','SUIUSDT','LINKUSDT','AVAXUSDT','ADAUSDT','NEARUSDT','APTUSDT','LTCUSDT','DOTUSDT','UNIUSDT']

for label,pool in [('盈利币池(6)',GOOD),('全部(14)',ALL)]:
    print(f"\n═══ 方案A - {label} ═══")
    tt=tw=tr=0
    for s in pool:
        kl=get_k(s,'5m',8)
        if len(kl)<120: continue
        t,wr,r=bt(s,kl,cfgA)
        tt+=t; tr+=r; tw+=round(t*wr/100)
        print(f"  {s:11s} {t:3d}笔 胜{wr:5.1f}% 回报{r:+8.1f}% {'🟢' if r>0 else '🔴'}")
    wr=round(tw/tt*100,1) if tt else 0
    print(f"  ══ 汇总: {tt}笔 胜率{wr}% 总回报{tr:+.1f}%")
