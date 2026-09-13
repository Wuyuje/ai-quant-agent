#!/usr/bin/env python3
"""回测: 轮中动量策略 在不同 MAX_P(份额价上限) 下的胜率与收益
策略(与原 auto_bot 一致):
  - 每个5分钟轮, 第3分钟(取轮中3分钟时刻) 计算 BTC 偏离 dev
  - 若 |dev| >= MIN_DEV(0.05%) 则信号, 方向=UP/DOWN
  - 份额价 p: 建模为市场定价, ask 与偏离联动
  - MAX_P 门槛: p > MAX_P 则跳过(不买贵)
  - 结算: 轮结束 BTC 收在轮起点上方 -> UP赢, 下方 -> DOWN赢
  - 收益(买$1): 赢赚(1-p), 输亏-p, 扣手续费
"""
import ccxt, time
import numpy as np

ex = ccxt.binance({"enableRateLimit": True})

def backtest(maxp, min_dev=0.05, fee=0.07, days=60, PRICE_MODEL="naive"):
    """PRICE_MODEL: naive=ask固定0.5; linked=ask与偏离联动(市场定价)"""
    # 拉5m + 1m 数据
    tf5 = ex.fetch_ohlcv("BTC/USDT", "5m", limit=int(days*288))
    rows5 = tf5
    c5 = [r[4] for r in rows5]
    o5 = [r[1] for r in rows5]
    t5 = [r[0]/1000 for r in rows5]
    n = len(rows5)

    # 用1m数据近似每轮第3分钟的偏离
    tf1 = ex.fetch_ohlcv("BTC/USDT", "1m", limit=int(days*1440))
    d1 = {}
    for r in tf1:
        k = (int(r[0]/1000)//300)*300
        d1.setdefault(k, []).append(r[4])

    stats = {"andel": 0, "win": 0, "loss": 0, "skip_expensive": 0, "skip_nosig": 0, "pnl": 0.0, "vol": 0.0}
    # 从第2根K线起
    for i in range(1, n-1):
        rts = t5[i]
        open_p = o5[i]
        # 该轮的1m收盘序列(第3分钟: 取第3根, 即约3分钟)
        vals = d1.get(rts)
        if not isinstance(vals, list) or len(vals)==0:
            vals=[c5[i]]
        if len(vals) >= 3:
            third = vals[2]  # 第3分钟价
        else:
            third = vals[-1] if vals else c5[i]
        # 偏离: 用第3分钟价 vs 轮起点
        dev = (third - open_p) / open_p * 100
        # 轮结束价
        close_p = c5[i]
        # 结算方向
        result = 1 if close_p > open_p else (-1 if close_p < open_p else 0)
        if result == 0: continue

        if abs(dev) < min_dev:
            stats["skip_nosig"] += 1
            continue

        side = 1 if dev > 0 else -1  # UP/DOWN

        if PRICE_MODEL == "naive":
            # 假设份额价固定 0.5 (理想便宜)
            p = 0.5
        else:
            # 市场定价: ask(UP) = clamp(0.5 + dev_k * 偏离), 方向份额价
            k = 6.0  # 敏感系数 (偏离0.1% -> 份额价0.506, 偏离3% -> 0.68)
            base_p = 0.5 + dev * k / 100
            base_p = max(0.05, min(0.95, base_p))
            # 买的方向份额价 = 若 side UP 则 base_p, 若 DOWN 则 1-base_p
            p = base_p if side == 1 else (1 - base_p)

        if p > maxp:
            stats["skip_expensive"] += 1
            continue

        # 开仓
        stats["andel"] += 1
        win = (side == result)
        if win:
            stats["win"] += 1
            stats["pnl"] += (1 - p - fee)
        else:
            stats["loss"] += 1
            stats["pnl"] += (-p - fee)
        stats["vol"] += 1

    trades = stats["andel"]
    wr = round(stats["win"]/trades*100, 1) if trades else 0
    return {
        "maxp": maxp,
        "trades": trades,
        "win": stats["win"],
        "loss": stats["loss"],
        "winrate": wr,
        "pnl": round(stats["pnl"], 2),
        "skip_expensive": stats["skip_expensive"],
        "skip_nosig": stats["skip_nosig"],
        "roi": round(stats["pnl"]/trades*100, 1) if trades else 0,
    }

print(f"=== MAX_P 回测 (market-linked pricing) ===")
# 市场定价模型更贴近真实
for mp in [0.50, 0.52, 0.55, 0.58, 0.60, 0.62, 0.65, 0.68, 0.70, 0.75, 0.80]:
    try:
        r = backtest(maxp=mp, PRICE_MODEL="linked")
        print(f"MAX_P={mp:.2f}: 交易{r['trades']:4d} 胜率{r['winrate']:6.1f}% 收益{r['pnl']:+7.2f}$ ROI{r['roi']:+7.1f}% 跳贵={r['skip_expensive']:4d} 无信号={r['skip_nosig']}")
    except Exception as e:
        print(f"MAX_P={mp:.2f} 错误: {repr(e)[:80]}")
