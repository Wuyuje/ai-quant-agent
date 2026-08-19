#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EMA 策略「加方向闸门前后」效果对比回测
复刻 agent-manager._trendAlignGate 的闸门逻辑:
  闸门1 EMA200 同向(LONG需价>=EMA200, SHORT需价<=EMA200)
  闸门2 4h大周期趋势同向(4h多头排列禁空/空头排列禁多/横盘按价vs 4h EMA99)
对比: 修复前(无闸门) vs 修复后(有闸门) 的 笔数/胜率/均单/总收益
数据源: 币安 15m + 4h 真实K线
"""
import urllib.request, json, time

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','FETUSDT','SUIUSDT','ARBUSDT']

def get_klines(sym, interval='15m', pages=2):
    data=[]
    endTime=''
    try:
        for _ in range(pages):
            url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
            if endTime: url+=f'&endTime={endTime}'
            req=urllib.request.Request(url,headers=UA)
            batch=json.loads(urllib.request.urlopen(req,timeout=12).read().decode())
            if not batch: break
            data=batch+data
            endTime=str(batch[0][0]); time.sleep(0.15)
    except Exception as e:
        return []
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'v':float(x[5]),'t':x[0]} for x in data]

def ema(c,n):
    if len(c)<n: return None
    k=2/(n+1);e=c[-n]
    for i in range(len(c)-n+1,len(c)): e=c[i]*k+e*(1-k)
    return e

def ema_series(v,n):
    if len(v)<n: return [None]*len(v)
    out=[None]*len(v); k=2/(n+1); e=v[0]; out[0]=e
    for i in range(1,len(v)):
        e=v[i]*k+e*(1-k); out[i]=e
    return out



# 只EMA200闸门(方案2: 去掉4h, 只保留EMA200)
def gate_pass_ema200(sig, price, e200_15m):
    if e200_15m is None: return True
    if sig=='LONG' and not (price>=e200_15m): return False
    if sig=='SHORT' and not (price<=e200_15m): return False
    return True

# 方向闸门(复刻 _trendAlignGate), 返回 True=通过(顺势可开), False=禁开(逆势)
def gate_pass(sig, price, e200_15m, c4, p4, e7_4, e25_4, e99_4):
    # 闸门1 EMA200同向
    if e200_15m is not None:
        if sig=='LONG' and not (price>=e200_15m): return False
        if sig=='SHORT' and not (price<=e200_15m): return False
    # 闸门2 4h大周期趋势
    if c4 and len(c4)>=60:
        up4=e7_4>e25_4>e99_4; dn4=e7_4<e25_4<e99_4
        if up4 and sig=='SHORT': return False
        if dn4 and sig=='LONG': return False
        if not up4 and not dn4:
            if sig=='LONG' and not (p4>=e99_4): return False
            if sig=='SHORT' and not (p4<=e99_4): return False
    return True

# 单币回测 返回 (原版统计, 加闸门统计)
def backtest(sym):
    kl=get_klines(sym,'15m',2)
    if len(kl)<400: return None
    kl.sort(key=lambda x:x['t'])
    c=[k['c'] for k in kl]
    # 4h 数据(用于闸门2)
    k4=get_klines(sym,'4h',1); k4.sort(key=lambda k:k['t'])
    c4=[k['c'] for k in k4]
    # 预计算 4h EMA7/25/99 (最近值)
    e7_4=ema(c4,7); e25_4=ema(c4,25); e99_4=ema(c4,99)
    p4=c4[-1]
    # 预计算15m EMA7/25/99/200
    e7s=ema_series(c,7); e25s=ema_series(c,25); e99s=ema_series(c,99); e200s=ema_series(c,200)

    o_t=o_w=0; o_ret=0.0            # 原版
    g_t=g_w=0; g_ret=0.0            # 双闸门(EMA200+4h)
    e_t=e_w=0; e_ret=0.0            # 只EMA200闸门
    pos=None; gate_state=0; gate1=0 # gate_state=双闸门允许; gate1=只EMA200允许
    for i in range(200,len(c)-1):
        price=c[i]; e7=e7s[i]; e25=e25s[i]; e99=e99s[i]
        hi30=max(c[i-30:i]); lo30=min(c[i-30:i])
        if pos:
            # 平仓逻辑(EMA反转/破EMA99)
            if pos=='LONG':
                if (e7 is not None and e25 is not None and e7<e25 and price<e25) or (e99 is not None and price<e99):
                    r=(price-pos_entry)/pos_entry
                    o_ret+=r; o_t+=1; o_w+=1 if r>0 else 0
                    if gate_state: g_ret+=r; g_t+=1; g_w+=1 if r>0 else 0
                    pos=None
            else:
                if (e7 is not None and e25 is not None and e7>e25 and price>e25) or (e99 is not None and price>e99):
                    r=(pos_entry-price)/pos_entry
                    o_ret+=r; o_t+=1; o_w+=1 if r>0 else 0
                    if gate_state: g_ret+=r; g_t+=1; g_w+=1 if r>0 else 0
                    pos=None
        else:
            # 开仓信号
            sig=None
            if e7 and e25 and e99:
                if e7>e25>e99 and (price>hi30 or (e25 and price>=e25*0.998)): sig='LONG'
                elif e7<e25<e99 and (price<lo30 or (e25 and price<=e25*1.002)): sig='SHORT'
            if sig:
                pos=sig; pos_entry=price
                gate_state = 1 if gate_pass(sig,price,e200s[i],c4,p4,e7_4,e25_4,e99_4) else 0

    return (o_t,o_w,o_ret),(g_t,g_w,g_ret)

def st(t,w,ret):
    return f"{t}笔/{(w/t*100 if t else 0):.1f}%/{ret*100:+.2f}%"

print("═══ EMA策略 加方向闸门前后 对比回测(币安15m,每币2页≈10天+4h闸门) ═══\n")
tot_o=[0,0,0.0]; tot_g=[0,0,0.0]
for sym in SYMBOLS:
    try:
        r=backtest(sym)
        if not r: continue
        (o_t,o_w,o_ret),(g_t,g_w,g_ret)=r
        tot_o[0]+=o_t;tot_o[1]+=o_w;tot_o[2]+=o_ret
        tot_g[0]+=g_t;tot_g[1]+=g_w;tot_g[2]+=g_ret
        diff=(g_t-o_t)
        print(f"{sym:10} 修复前:{st(o_t,o_w,o_ret):24} | 加闸门:{st(g_t,g_w,g_ret):24} | 笔数{diff:+d}")
    except Exception as e:
        print(f"{sym:10} err {str(e)[:25]}")
print("\n═══ 汇总 ═══")
def sum_line(total):
    t,w,ret=total
    return f"{t}笔 胜率{(w*100/t if t else 0):.1f}% 均单{(ret*100/t if t else 0):+.3f}% 总{(ret*100):+.2f}%"
print(f"修复前(无闸门): {sum_line(tot_o)}")
print(f"加闸门(修复后): {sum_line(tot_g)}")
