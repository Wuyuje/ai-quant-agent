#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
收敛突破策略 回测 (币安 1h 真实数据)
核心逻辑(最佳方案):
  1. 布林带收口收敛(带宽压缩 到带宽分位低位) → 积蓄能量
  2. 突破(收盘穿过上轨/下轨) → 顺向开仓
  3. 用 ATR 移动止损让利润奔跑(盈亏比优先, 不是吃小利)
  4. 波动率目标仓位: 单笔亏损固定比例(用%恒等, 杠杆由ATR反推)
验证: 胜率 / 盈亏比 / 期望值 — 是否真实为正
对比: 现有"触轨就开" vs "收敛后再突破"
"""
import urllib.request, json, time, math

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','SUIUSDT','ARBUSDT','INJUSDT']

def get_klines(sym, interval='1h', pages=3):
    data=[]; endTime=''
    try:
        for _ in range(pages):
            url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
            if endTime: url+=f'&endTime={endTime}'
            batch=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read().decode())
            if not batch: break
            data=batch+data; endTime=str(batch[0][0]); time.sleep(0.15)
    except Exception: return []
    return [{'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'v':float(x[5]),'t':x[0]} for x in data]

def boll_bands(c, n=20, k=2.0, up_to_i=None):
    """返回 i 处的布林带宽{mid,upper,lower,width}"""
    seg=c[up_to_i-n:up_to_i]
    if len(seg)<n: return None
    mid=sum(seg)/n
    sd=math.sqrt(sum((x-mid)**2 for x in seg)/n)
    upper=mid+k*sd; lower=mid-k*sd
    width=(upper-lower)/(mid or 1)
    return {'mid':mid,'upper':upper,'lower':lower,'width':width,'sd':sd}

def atr(arr, i, n=14):
    if i<n+1: return None
    trs=[]
    for j in range(i-n+1,i+1):
        h=arr[j]['h']; l=arr[j]['l']; pc=arr[j-1]['c']
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs)/len(trs)

def backtest(sym):
    kl=get_klines(sym,'1h',3)
    if len(kl)<500: return None
    c=[k['c'] for k in kl]
    # 策略1: 收敛突破(收口到带宽分位低, 再突破)
    # 策略2: 触轨就开(现有布林) — 对比
    # 用简化持仓: 开仓后, ATR移动止损持仓,maxBars封顶
    def calc_width_pct(i, cur_width):
        # 前100根(含)里, 高于cur的占比 → 分位
        if i<120: return 0.5
        wins=[]
        for j in range(i-100,i):
            b=boll_bands(c,20,2.0,j+1)
            if b: wins.append(b['width'])
        if not wins: return 0.5
        return sum(1 for w in wins if w<cur_width)/len(wins)

    res_conv={'t':0,'w':0,'ret':0.0}
    res_touch={'t':0,'w':0,'ret':0.0}
    pos=None
    for i in range(121,len(c)-1):
        if pos is not None: continue  # 简化: 一笔结束再下一笔
        b=boll_bands(c,20,2.0,i+1)
        if not b: continue
        price=c[i]
        wpc=calc_width_pct(i,b['width'])
        # 收敛判定: 带宽分位<30%(很窄)
        convergent = wpc < 0.30
        a=atr(kl,i)
        sig_conv=None; sig_touch=None
        # 触轨就开
        if price>=b['upper']: sig_touch='SHORT'
        elif price<=b['lower']: sig_touch='LONG'
        # 收敛突破(先收敛再穿过轨)
        if convergent:
            if price>=b['upper']: sig_conv='SHORT'
            elif price<=b['lower']: sig_conv='LONG'
        # 模拟一笔: 开仓后, ATR移动止损(止损=1.5ATR, 止盈=3ATR → 盈亏比2:1)
        def sim_one(sig, b, i, a):
            if sig is None: return None,None,None
            entry=c[i]
            atr_v=a or (b['sd']*0.5)
            stop_dist=1.5*atr_v
            tp_dist=3.0*atr_v   # 盈亏比2:1
            for j in range(i+1, min(i+100,len(c))):
                hi=kl[j]['h']; lo=kl[j]['l']
                if sig=='LONG':
                    if lo<=entry-stop_dist: return 'LOSS', entry,tp_dist
                    if hi>=entry+tp_dist: return 'WIN', entry,tp_dist
                else:
                    if hi>=entry+stop_dist: return 'LOSS', entry,tp_dist
                    if lo<=entry-tp_dist: return 'WIN', entry,tp_dist
            return 'FLAT', entry, tp_dist  # 到封顶未触发
        # 跑触轨
        r_t,en,td=sim_one(sig_touch,b,i,a)
        if r_t:
            res_touch['t']+=1
            if r_t=='WIN': res_touch['w']+=1; res_touch['ret']+=1.0   # 盈亏比利润=1单位
            else: res_touch['ret']-=0.5                                 # 亏损=0.5单位(1:2止损/盈)
        # 跑收敛
        r_c,en,td=sim_one(sig_conv,b,i,a)
        if r_c:
            res_conv['t']+=1
            if r_c=='WIN': res_conv['w']+=1; res_conv['ret']+=1.0
            else: res_conv['ret']-=0.5
    return res_touch,res_conv

print("═══ 布林: 触轨就开 vs 收敛突破 回测(币安1h, 盈亏比2:1, ATR止损) ═══\n")
agg_t=[0,0,0.0]; agg_c=[0,0,0.0]
print("币种      触轨就开[t/胜/期望]        收敛突破[t/胜/期望]")
for sym in SYMBOLS:
    try:
        r=backtest(sym)
        if not r: continue
        rt,rc=r
        def f(r): return f"{r['t']}/{r['w']*100//r['t']}%/{r['ret']:+}%"
        agg_t[0]+=rt['t'];agg_t[1]+=rt['w'];agg_t[2]+=rt['ret']
        agg_c[0]+=rc['t'];agg_c[1]+=rc['w'];agg_c[2]+=rc['ret']
        print(f"{sym:10} {f(rt):22} {f(rc)}")
    except Exception as e:
        print(f"{sym:10} err {str(e)[:22]}")
print("\n═══ 汇总(期望值>0才有价值) ═══")
for agg,l in [((agg_t),'触轨就开'),(agg_c,'收敛突破')]:
    t,w,ret=agg
    exp=ret/t if t else 0
    print(f"{l}: {t}笔 胜率{w*100//t if t else 0}% 期望每笔{exp:+.3f}单位 总{ret:+.1f}")
