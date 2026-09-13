
# pnl_model.py — 收益模型: 轮末确定性策略的期望收益
# 依据回测: 轮末偏离越大胜率越高; 结合当前价格p与手续费, 算期望, 决定是否下单
def winrate(dev_pct):
    # 从回测拟合: 偏离越大胜率越高
    if dev_pct>=0.05: return 0.968
    if dev_pct>=0.03: return 0.929
    if dev_pct>=0.02: return 0.912
    if dev_pct>=0.01: return 0.863
    return 0.80
def expected(p, dev_pct, N=1.0, fee_rate=0.07):
    wr=winrate(dev_pct)
    # 买领先方向(价格p, 已倾斜, 通常>0.5)
    # 赢: 每股赚(1-p); 输: 每股亏p; 手续费=C*fee_rate*p*(1-p)
    C=N/p
    win_pnl=(1-p)*C
    lose_pnl=-p*C
    fee=C*fee_rate*p*(1-p)
    exp=wr*win_pnl+(1-wr)*lose_pnl-fee
    return wr, exp, win_pnl, lose_pnl, fee
# 测试不同价格与偏离
print("价格p | 偏离% | 胜率 | 期望收益(每$1) | 说明")
for p in (0.5,0.6,0.7,0.8,0.9,0.95):
    for dev in (0.02,0.05):
        wr,exp,wpn,lpn,fee=expected(p,dev)
        tag="✅可下" if exp>0 else "❌不下"
        print(f" {p:.2f} | {dev:.2f} | {wr:.1%} | {exp:+.4f} | {tag}")
