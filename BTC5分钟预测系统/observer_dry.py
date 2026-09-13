#!/usr/bin/env python3
# observer_dry.py — 干跑观察: 复用新收益逻辑, 只读twap_state打印判断, 不下单
import time, json, datetime
ROOT="/root/polymarket-btc5"

def winrate(dev):
    d=abs(dev)*100
    if d>=0.10: return 0.98
    if d>=0.07: return 0.96
    if d>=0.05: return 0.94
    if d>=0.03: return 0.90
    return 0.80
def expect_ok(p, dev, up=True):
    if abs(dev) < 0.04: return False, -1
    if p > 0.40: return False, -1
    wr=winrate(dev); C=1.0/p
    exp=wr*(1-p)*C-(1-wr)*p*C - C*0.07*p*(1-p)
    return exp>=0.20, exp

last_sig=None
print("🟢 干跑观察启动 (不下单, 只记录新策略判断)", flush=True)
while True:
    try:
        tw=json.load(open(ROOT+"/twap_state.json"))
        sig=tw.get("signal")
        dev=tw.get("dev") or 0
        remain=tw.get("remain")
        round_info=tw.get("round") or {}
        ask=round_info.get("ask") or 0.5
        bid=round_info.get("bid") or ask
        if sig in ("UP","DOWN"):
            p=ask if sig=="UP" else (1-ask)
            ok,exp=expect_ok(p, dev, up=(sig=="UP"))
            print(f"[{datetime.datetime.now():%H:%M:%S}] 信号={sig} remain={remain}s dev={dev*100:.2f}% ask={ask} 买份额价p={p:.3f} → 新策略判断: {'✅会下单' if ok else '⛔跳过'} (exp={exp:.3f})", flush=True)
        else:
            ts=int(time.time()); k=(ts//300)*300
            if k%(300) < 10:  # 每轮开始10秒内打一次
                print(f"[{datetime.datetime.now():%H:%M:%S}] 观察中 sig=观察 remain={remain}s dev={dev*100:.2f}%", flush=True)
    except Exception as e:
        print("obs err", repr(e)[:80], flush=True)
    time.sleep(4)
