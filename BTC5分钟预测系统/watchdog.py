#!/usr/bin/env python3
# watchdog.py — 自动守护 Polymarket BTC5 后台进程
# 检查: 进程是否存活 + twap_state 是否陈旧; 异常则重启
import os, time, subprocess, json, datetime

ROOT="/root/polymarket-btc5"
PY=ROOT+"/v311/bin/python"
PK=os.getenv("POLY_PK","0xd881c3d2589921dde4fa35e73cad8cd28389fd13b8deae2b7b7ead48bd3723f5")
WALLET=os.getenv("POLY_WALLET","0xe1688A2094690a69DC103832f8edc1E8Daf1171d")
ADMIN=os.getenv("ADMIN","0x9999c0FC24d4468aFa840fC5C1b5f01775B5eE79")

def alive(name):
    try:
        out=subprocess.run(["pgrep","-f",name],capture_output=True,text=True).stdout.strip()
        return bool(out)
    except: return False

def start(cmd, log):
    with open(log,"a") as f:
        subprocess.Popen(cmd, stdout=f, stderr=f, start_new_session=True)
    return True

def twap_fresh(max_age=90):
    """twap_state.json 是否在 max_age 秒内更新过"""
    try:
        p=ROOT+"/twap_state.json"
        if not os.path.exists(p): return False
        age=time.time()-os.path.getmtime(p)
        return age < max_age
    except: return False

def log(msg):
    print(f"[{datetime.datetime.now():%H:%M:%S}] {msg}", flush=True)

def main():
    log("watchdog started")
    while True:
        try:
            # 1) 进程存活检查
            jobs=[
                ("round_recorder.py", ROOT+"/rr.log"),
                ("stats_loop.py",     ROOT+"/sl.log"),
                ("twap_strategy.py",  ROOT+"/tw.log"),
                ("platform_server.py",ROOT+"/platform.log"),
            ]
            for name, lg in jobs:
                if not alive(name):
                    log(f"RESTART {name}")
                    start([PY, name], lg)
            # auto_bot -> 改为多用户独立引擎 (用各用户自己的私钥, 不需全局PK)
            if not alive("multi_auto_bot.py"):
                log("RESTART multi_auto_bot.py")
                start([PY,"multi_auto_bot.py"], ROOT+"/multi_bot.log")
            # 2) twap_state 陈旧检查 (twap_strategy 卡死检测)
            if not twap_fresh(120):
                log("twap_state STALE -> restart twap_strategy")
                subprocess.run(["pkill","-9","-f","twap_strategy.py"],capture_output=True)
                time.sleep(2)
                start([PY,"twap_strategy.py"], ROOT+"/tw.log")
        except Exception as e:
            log("watchdog err: "+repr(e)[:120])
        time.sleep(30)

if __name__=="__main__":
    main()
