import sys; sys.path.insert(0,'.')
exec(open('bt_tf.py').read().split("POOL=")[0])  # 复用 bt 函数

POOL=['NEARUSDT','SOLUSDT','ETHUSDT']
print("═══ 15m 稳定性验证(不同数据窗口) ═══")
for pages in [3,4,6,8,10]:
    cfg=dict(iv='15m', maxadx=25, maxbw=6.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68, tp=2.0, slatr=2.0, maxloss=8, maxbars=40, lev=5)
    tt=tw=tr=0; det=[]
    for s in POOL:
        kl=get_k(s,'15m',pages)
        if len(kl)<120: continue
        t,wr,r,avgw,avgl=bt(s,kl,cfg)
        tt+=t; tr+=r; tw+=round(t*wr/100); det.append(f"{s[:4]}:{r:+.0f}")
    wr=round(tw/tt*100,1) if tt else 0
    print(f"  pages={pages}(约{pages*1000*15//1440}天): {tt:3d}笔 胜{wr:5.1f}% 回报{tr:+7.1f}% {'🟢' if tr>0 else '🔴'} [{' '.join(det)}]")

# 也测更多币(验证是否只是这3币)
print("\n═══ 15m 更多币种验证(pages=8) ═══")
ALL=['ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','NEARUSDT','APTUSDT','LTCUSDT','DOTUSDT','AVAXUSDT','UNIUSDT']
cfg=dict(iv='15m', maxadx=25, maxbw=6.0, maxbwpctl=70, rsi_lo=32, rsi_hi=68, tp=2.0, slatr=2.0, maxloss=8, maxbars=40, lev=5)
tt=tw=tr=0
for s in ALL:
    kl=get_k(s,'15m',8)
    if len(kl)<120: continue
    t,wr,r,avgw,avgl=bt(s,kl,cfg)
    tt+=t; tr+=r; tw+=round(t*wr/100)
    print(f"  {s:11s} {t:3d}笔 胜{wr:5.1f}% 回报{r:+7.1f}% {'🟢' if r>0 else '🔴'}")
wr=round(tw/tt*100,1) if tt else 0
print(f"  ══ 汇总: {tt}笔 胜率{wr}% 总回报{tr:+.1f}%")
