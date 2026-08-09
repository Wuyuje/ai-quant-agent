#!/usr/bin/env python3
# ═══ 自动看门狗: 周期检查关键服务, 挂了自动重启 ═══
import subprocess, time, os, sys, signal

def is_running(procname):
    try:
        out = subprocess.run(['pgrep','-f',procname], capture_output=True, text=True)
        return bool(out.stdout.strip())
    except:
        return False

def start(procname, cmd):
    print(f'[{time.strftime("%H:%M:%S")}] 🚀 启动 {procname}')
    subprocess.Popen(cmd, shell=True, start_new_session=True, executable='/bin/bash')
    time.sleep(5)

# 服务定义
services = [
    ('quant/start', 'cd /app/workspace/ai-quant-agent && TZ=Asia/Shanghai nohup node quant/start.js >> /tmp/quant-watchdog.log 2>&1 &'),
    ('run-usersystem', 'cd /app/workspace/ai-quant-agent && TZ=Asia/Shanghai nohup node saas/run-usersystem.js >> /tmp/usersys-watchdog.log 2>&1 &'),
]

print('🛡️ 守护进程启动: 每60秒检查关键服务')
while True:
    for procname, cmd in services:
        if not is_running(procname):
            print(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] ⚠️ {procname} 已停止→重启')
            start(procname, cmd)
    time.sleep(60)
