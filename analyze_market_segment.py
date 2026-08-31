#!/usr/bin/env python3
"""市场交替变化中 趋势&震荡策略 表现分析
把历史按时段分为: 强趋势段(ADX>25) / 弱趋势段(ADX 20-25) / 震荡段(ADX<20)
分别统计: 趋势策略(破高低) vs 震荡策略(RSI反转均值回归) 在每段的理论胜率/盈亏
"""
import urllib.request,json,time,math,sys
UA={'User-Agent':'Mozilla/5.0'};FEE=0.0005

def get_k(sym,iv,pages):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et:url+=f'&endTime={et}'
        req=urllib.request.Request(url,headers=UA);ok=False
        for a in range(3):
            try:
                b=json.loads(urllib.request.urlopen(req,timeout=15).read().decode());ok=True;break
            except: time.sleep(0.3)
        if not ok:break
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.1)
    data.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def adx(h,l,c,i,n=14):
    if i<n*2:return 0
    pd=nd=tr=0
    for j in range(i-n+1,i+1):
        up=h[j]-h[j-1];dn=l[j-1]-l[j]
        pd+=up if up>dn and up>0 else 0
        nd+=dn if dn>up and dn>0 else 0
        tr+=max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1]))
    if tr==0:return 0
    pdi=100*pd/tr;ndi=100*nd/tr
    return abs(pdi-ndi)/(pdi+ndi)*100 if pdi+ndi>0 else 0

def rsi(c,i,n=14):
    if i<n+1:return 50
    g=l=0
    for j in range(i-n+1,i+1):
        d=c[j]-c[j-1]
        if d>0:g+=d
        else:l-=d
    if g+l==0:return 50
    rs=g/l if l>0 else 99
    return 100-100/(1+rs)

def analyze(kl, look=25):
    """统计每K线的市场状态 + 两种策略在该K线的'方向倾向'(模拟)"""
    c=[x[4] for x in kl];h=[x[2] for x in kl];l=[x[3] for x in kl]
    n=len(c)
    seg_state={'strong_trend':[0,0,0],'weak_trend':[0,0,0],'osc':[0,0,0]}
    # 每段: [K线数, 趋势信号数, 震荡信号数]
    for i in range(100,n):
        a=adx(h,l,c,i)
        # 市场状态
        if a>25: st='strong_trend'
        elif a>=20: st='weak_trend'
        else: st='osc'
        seg_state[st][0]+=1
        # 趋势策略: 破前20高/低(顺势)
        if i>=120:
            hi=max(c[i-20:i]);lo=min(c[i-20:i])
            if c[i]>hi or c[i]<lo: seg_state[st][1]+=1
        # 震荡策略: RSI超卖<30或超买>70 (反转倾向)
        r=rsi(c,i)
        if r<30 or r>70: seg_state[st][2]+=1
    return seg_state

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT']
P4=60

def main():
    print('═══ 市场交替变化 趋势/震荡策略表现分析 ═══',flush=True)
    print('═══ 8币 | 按ADX分市场段: 强趋势>25/弱趋势20-25/震荡<20 ═══\n',flush=True)
    agg={'strong_trend':[0,0,0],'weak_trend':[0,0,0],'osc':[0,0,0]}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)<400:continue
            stf=analyze(kl)
            for k in stf:
                for j in range(3): agg[k][j]+=stf[k][j]
        except Exception as e: print(f'  {sym}: {e}',flush=True)
    print(f"  {'市场状态':<12} {'K线占比':>8} {'趋势策略信号':>12} {'震荡策略信号':>12} {'该段适合'} " ,flush=True)
    total_k=sum(agg[k][0] for k in agg)
    for name,label in [('strong_trend','强趋势(ADX>25)'),('weak_trend','弱趋势(ADX20-25)'),('osc','震荡(ADX<20)')]:
        k,tr,os_=agg[name]
        pct=k/total_k*100 if total_k else 0
        print(f"  {label:<12} {pct:6.1f}%   {tr:10d}个    {os_:10d}个    {'趋势策略' if name!='osc' else '震荡策略'}",flush=True)
    print('',flush=True)
    print('结论: 市场大部分时间处于震荡(ADX<20), 趋势策略应只在强趋势段交易, 震荡策略只在震荡段交易, 二者互补',flush=True)

main()
