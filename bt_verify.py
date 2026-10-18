import sys; sys.path.insert(0,'.')
from bt_range_v8 import get_k, bt

POOL=['NEARUSDT','SOLUSDT','ETHUSDT']
# 用不同数据窗口验证稳定性
BASE=dict(iv='5m', maxadx=25, maxbw=3.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68, tp=1.5, slatr=2.0, maxloss=5, maxbars=30, lev=3)
print("═══ 稳定性验证: 不同数据窗口 (核心3币, 基础参数) ═══")
for pages in [2,3,4,6,8]:
    tt=tw=tr=0
    for s in POOL:
        kl=get_k(s,'5m',pages)
        if len(kl)<120: continue
        t,wr,r=bt(s,kl,BASE)
        tt+=t; tr+=r; tw+=round(t*wr/100)
    wr=round(tw/tt*100,1) if tt else 0
    print(f"  pages={pages}(约{pages*1000//288}天): {tt:3d}笔 胜{wr:5.1f}% 回报{tr:+7.1f}% {'🟢' if tr>0 else '🔴'}")

# 也测不同周期
print("\n═══ 不同周期 (pages=6) ═══")
for iv in ['1m','3m','5m','15m','30m']:
    tt=tw=tr=0
    cfg=dict(BASE); cfg['iv']=iv
    for s in POOL:
        kl=get_k(s,iv,6)
        if len(kl)<120: continue
        t,wr,r=bt(s,kl,cfg)
        tt+=t; tr+=r; tw+=round(t*wr/100)
    wr=round(tw/tt*100,1) if tt else 0
    print(f"  {iv:4s}: {tt:3d}笔 胜{wr:5.1f}% 回报{tr:+7.1f}% {'🟢' if tr>0 else '🔴'}")
