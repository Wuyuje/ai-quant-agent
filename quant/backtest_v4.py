#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
# 📊 V4 日线趋势策略回测
# 逻辑: 趋势结构(抬高低点/降低高点) + 关键位突破/回踩 + 量能 + 横盘检测
# 统计: 胜率/平均收益/总收益/最大回撤/交易分布
# ═══════════════════════════════════════════════════════════
import urllib.request, json, time

UA={'User-Agent':'Mozilla/5.0'}
K_URL='https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={0},m15,,320'
SYMBOLS=['sz002428','sh601869','sh603061','sh603129','sh603444','sh603986','sz002584','sh600519','sh601318','sh600036',
         'sz300059','sz002475','sh600536','sz300750','sz002371','sz002916','sz000858','sz000001']
swingLen=3; confirmLows=2; volMult=1.3

def get_kline(sym):
    try:
        req=urllib.request.Request(K_URL.format(sym),headers=UA)
        d=json.loads(urllib.request.urlopen(req,timeout=15).read().decode())
        k=d['data'][sym].get('m15') or d['data'][sym].get('qfqday') or []
        return [{'date':x[0],'open':float(x[1]),'close':float(x[2]),'high':float(x[3]),'low':float(x[4]),'vol':float(x[5])} for x in k]
    except: return []

def dir_structure(closes, i):
    """trend-structure dir: 抬高低点UP/降低高点DOWN"""
    lows=[];highs=[]
    for j in range(swingLen, i-swingLen):
        win=closes[j-swingLen:j+swingLen+1]
        if closes[j]==min(win): lows.append((j,closes[j]))
        if closes[j]==max(win): highs.append((j,closes[j]))
    if len(lows)>=3:
        a,b,c=lows[-3:]
        if b[1]>a[1] and c[1]>b[1]: return 'UP', c[1], highs[-1][1] if highs else 0
    if len(highs)>=3:
        a,b,c=highs[-3:]
        if b[1]<a[1] and c[1]<b[1]: return 'DOWN', c[1], lows[-1][1] if lows else 0
    return 'FLAT',0,0

def keylevel(closes, i):
    lows=[closes[j] for j in range(swingLen,i) if closes[j]==min(closes[j-swingLen:j+swingLen+1])]
    highs=[closes[j] for j in range(swingLen,i) if closes[j]==max(closes[j-swingLen:j+swingLen+1])]
    return (min(lows[-3:]) if len(lows)>=2 else 0, max(highs[-3:]) if len(highs)>=2 else 0)

def is_range(closes, i):
    win=closes[i-40:i]; 
    if len(win)<20: return True
    hi,lo=max(win),min(win); rng=(hi-lo)/lo*100
    if rng<3: return True
    seg=win[-30:]; up=sum(1 for k in range(1,len(seg)) if seg[k]>seg[k-1]); ratio=up/(len(seg)-1)
    return 0.35<=ratio<=0.65

def backtest(stocks, exit_mode):
    closes=[s['close'] for s in stocks]
    pos=None; trades=w=0; ret=0; daily=[]
    for i in range(50, len(stocks)-1):
        if pos:
            d1=closes[i]; 
            # 判断出场: 反向结构破坏 或 跌破支撑(简化: 用EMA20反转)
            if pos=='LONG' and d1<closes[i-1] and closes[i-1]<closes[i-2]:
                exit_p=stocks[i]['close']; trade_ret=(exit_p-pos_entry)/pos_entry; ret+=trade_ret; trades+=1
                if trade_ret>0: w+=1
                daily.append(trade_ret); pos=None
            elif pos=='SHORT' and d1>closes[i-1] and closes[i-1]>closes[i-2]:
                exit_p=stocks[i]['close']; trade_ret=(pos_entry-exit_p)/pos_entry; ret+=trade_ret; trades+=1
                if trade_ret>0: w+=1
                daily.append(trade_ret); pos=None
        else:
            if is_range(closes,i): continue
            dir_,sup,res=dir_structure(closes,i)
            if dir_=='FLAT': continue
            price=closes[i]; prev=closes[i-1]
            ks,kr=keylevel(closes,i)
            res2=res or kr; sup2=sup or ks
            v_ratio = stocks[i]['vol']/(sum(s['vol'] for s in stocks[i-20:i])/20) if i>20 else 1
            v_up = v_ratio>volMult
            # 入场: 放量突破/回踩
            if dir_=='UP' and res2>0 and price>res2 and prev<=res2 and v_up:
                pos='LONG'; pos_entry=price
            elif dir_=='UP' and sup2>0 and price>=sup2*0.998 and v_up:
                pos='LONG'; pos_entry=price
            elif dir_=='DOWN' and sup2>0 and price<sup2 and prev>=sup2 and v_up:
                pos='SHORT'; pos_entry=price
            elif dir_=='DOWN' and res2>0 and price<=res2*1.002 and v_up:
                pos='SHORT'; pos_entry=price
    wr=w/trades*100 if trades else 0
    avg=ret/trades*100 if trades else 0
    cum=0;mx=0;peak=0
    for r in daily: cum+=r;peak=max(peak,cum);mx=min(mx,cum-peak)
    return {'t':trades,'wr':round(wr,1),'avg':round(avg,2),'total':round(ret*100,1),'dd':round(mx*100,1)}

def main():
    print("V4 日线趋势策略回测 (近1年日K)...")
    res=[]
    for sym in SYMBOLS:
        s=get_kline(sym)
        if not s: continue
        r=backtest(s,'simple')
        if r['t']>0: res.append(r)
        print(f"{sym}: 交易{r['t']} 胜率{r['wr']}% 均{r['avg']}% 总{r['total']}% 回撤{r['dd']}%")
        time.sleep(0.5)
    if res:
        t=sum(x['t'] for x in res); wsum=sum(x['t']*x['wr']/100 for x in res)
        av=sum(x['avg'] for x in res)/len(res)
        print(f"\n═══ V4汇总 ═══\n总交易{t} 平均胜率{round(wsum/t*100,1)}% 平均单笔{round(av,2)}%\n注: 日线趋势结构+量能+横盘过滤, 出场=趋势反转")

if __name__=='__main__': main()
