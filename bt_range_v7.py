import sys; sys.path.insert(0,'.')
from bt_range_v5 import get_k, bt

POOLS={
 '核心3(NEAR/SOL/ETH)':['NEARUSDT','SOLUSDT','ETHUSDT'],
 '核心5(加XRP/ADA)':['NEARUSDT','SOLUSDT','ETHUSDT','XRPUSDT','ADAUSDT'],
 '核心6':['NEARUSDT','SOLUSDT','ETHUSDT','XRPUSDT','ADAUSDT','LINKUSDT'],
}
# 参数变体: 调整止盈/止损
CFGS=[
 dict(tag='A1 tp1.5 sl2.0 ml5', tp=1.5, slatr=2.0, maxloss=5, maxbars=30),
 dict(tag='A2 tp2.0 sl1.5 ml4', tp=2.0, slatr=1.5, maxloss=4, maxbars=20),
 dict(tag='A3 tp1.2 sl1.5 ml3', tp=1.2, slatr=1.5, maxloss=3, maxbars=15),
 dict(tag='A4 tp1.5 sl1.2 ml3', tp=1.5, slatr=1.2, maxloss=3, maxbars=20),
]
base=dict(iv='5m', maxadx=25, maxbw=3.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68, lev=3, use_super=True)
print("═══ 震荡策略精调 (5m, 优币池) ═══")
best=None
for pname,pool in POOLS.items():
    for c in CFGS:
        cfg=dict(base); cfg.update({k:v for k,v in c.items() if k!='tag'})
        tt=tw=tr=0
        for s in pool:
            kl=get_k(s,'5m',8)
            if len(kl)<120: continue
            t,wr,r=bt(s,kl,cfg)
            tt+=t; tr+=r; tw+=round(t*wr/100)
        wr=round(tw/tt*100,1) if tt else 0
        flag='🟢' if tr>0 else '🔴'
        print(f"  {pname:22s} {c['tag']:20s}: {tt:3d}笔 胜{wr:5.1f}% 回报{tr:+7.1f}% {flag}")
        if best is None or tr>best[2]: best=(pname,c['tag'],tr,wr,tt)
print(f"\n🟢 最优: {best[0]} | {best[1]} | 回报{best[2]:+.1f}% 胜率{best[3]}% {best[4]}笔")
