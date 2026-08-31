#!/usr/bin/env python3
"""验证: 趋势段趋势策略赚 / 震荡段震荡策略赚
按ADX分成 强趋势段(>25) 和 震荡段(<20), 分段回测:
  趋势段: 趋势策略(破20高低顺势) 应该赚
  震荡段: 震荡策略(RSI<30超卖/超买>70 反转) 应该赚
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
        data=b+data;et=str(b[0][0]);time.sleep(0.08)
    data.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def calc_b(c,i):
    seg=c[i-20:i];m=sum(seg)/20
    var=sum((x-m)**2 for x in seg)/20;sd=math.sqrt(var)
    return m+2*sd,m-2*sd
def atr(h,l,c,i):
    if i<14:return 0.0001
    return sum(max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])) for j in range(i-14,i+1))/14
def rsi(c,i):
    if i<15:return 50
    g=l=0
    for j in range(i-13,i+1):
        d=c[j]-c[j-1]
        if d>0:g+=d
        else:l-=d
    if g+l==0:return 50
    rs=g/l if l>0 else 99
    return 100-100/(1+rs)
def adx(h,l,c,i):
    if i<28:return 0
    pd=nd=tr=0
    for j in range(i-13,i+1):
        up=h[j]-h[j-1];dn=l[j-1]-l[j]
        pd+=up if up>dn and up>0 else 0
        nd+=dn if dn>up and dn>0 else 0
        tr+=max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1]))
    if tr==0:return 0
    pdi=100*pd/tr;ndi=100*nd/tr
    return abs(pdi-ndi)/(pdi+ndi)*100 if pdi+ndi>0 else 0

def seg_backtest(kl):
    """分段: 只统计每类市场的开仓, 用简化止盈止损, 累积胜率/盈亏"""
    c=[x[4] for x in kl];h=[x[2] for x in kl];l=[x[3] for x in kl]
    n=len(c)
    # 分段结果
    res={'trend_seg':{'t':0,'w':0,'pnl':0.0},'osc_seg':{'t':0,'w':0,'pnl':0.0}}
    pos=None
    for i in range(140,n-1):
        a=adx(h,l,c,i)
        seg='trend_seg' if a>25 else ('osc_seg' if a<20 else None)
        price=c[i];aa=atr(h,l,c,i)
        if pos:
            pct=(price-pos['e'])/pos['e'] if pos['side']=='L' else (pos['e']-price)/pos['e']
            sl=pos['e']-1.0*aa if pos['side']=='L' else pos['e']+1.0*aa
            tp=pos['e']+1.5*aa if pos['side']=='L' else pos['e']-1.5*aa
            isL=pos['side']=='L'
            if (isL and price<=sl) or (not isL and price>=sl):
                res[pos['seg']]['t']+=1
                if pct>0: res[pos['seg']]['w']+=1
                res[pos['seg']]['pnl']+=pct
                pos=None
            elif (isL and price>=tp) or (not isL and price<=tp):
                res[pos['seg']]['t']+=1
                if pct>0: res[pos['seg']]['w']+=1
                res[pos['seg']]['pnl']+=pct
                pos=None
            continue
        if seg is None: continue
        up,lo=calc_b(c,i)
        r=rsi(c,i)
        # 趋势段 → 趋势策略(破前20高低)
        if seg=='trend_seg':
            if i>=120:
                hi20=max(c[i-20:i]);lo20=min(c[i-20:i])
                if price>hi20: pos={'side':'L','e':price,'seg':seg}
                elif price<lo20: pos={'side':'S','e':price,'seg':seg}
        # 震荡段 → 震荡策略(RSI反转)
        elif seg=='osc_seg':
            if price<=lo and r<30: pos={'side':'L','e':price,'seg':seg}
            elif price>=up and r>70: pos={'side':'S','e':price,'seg':seg}
    return res

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT']
P4=60

def main():
    print('═══ 分段验证: 趋势段趋势策略 / 震荡段震荡策略 ═══',flush=True)
    print('═══ 8币 | 各自在自己市场段单独回测 ═══\n',flush=True)
    agg={'trend_seg':{'t':0,'w':0,'pnl':0.0},'osc_seg':{'t':0,'w':0,'pnl':0.0}}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)<400:continue
            r=seg_backtest(kl)
            for k in r:
                agg[k]['t']+=r[k]['t'];agg[k]['w']+=r[k]['w'];agg[k]['pnl']+=r[k]['pnl']
        except Exception as e: print(f'  {sym}: {e}',flush=True)
    for k,label in [('trend_seg','趋势段(ADX>25)用趋势策略'),('osc_seg','震荡段(ADX<20)用震荡策略')]:
        d=agg[k]
        wr=round(d['w']*100/d['t'],1) if d['t'] else 0
        print(f"  {label:<26} {d['t']:4}笔 胜率{wr:4.1f}% 累计盈亏{d['pnl']:+6.1f}%",flush=True)
    print('',flush=True)
    t=agg['trend_seg'];o=agg['osc_seg']
    print(f"验证结论: 趋势段趋势策略{'✅赚钱' if t['pnl']>0 else '❌亏'}({t['pnl']:+.1f}%), 震荡段震荡策略{'✅赚钱' if o['pnl']>0 else '❌亏'}({o['pnl']:+.1f}%)",flush=True)

main()
