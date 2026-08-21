#!/usr/bin/env python3
"""单独评估每个高位过滤, 找合理阈值"""
import urllib.request,json,time,math

UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005
def get_k(sym,iv,pages=5):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et:url+=f'&endTime={et}'
        req=urllib.request.Request(url,headers=UA)
        b=json.loads(urllib.request.urlopen(req,timeout=12).read().decode())
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.1)
    data.sort(key=lambda x:x[0])
    return [float(x[4]) for x in data]

def _ema_at(closes,i,n):
    if i<n:return None
    k=2/(n+1);e=closes[i-n+1]
    for x in range(i-n+2,i+1):e=closes[x]*k+e*(1-k)
    return e

def _atr(closes,n=14):
    trs=[]
    for i in range(1,len(closes)):
        h=max(closes[max(0,i-4):i+1]);l=min(closes[max(0,i-4):i+1]);pc=closes[i-1]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    return sum(trs[-n:])/n if len(trs)>=n else None

def signals(closes,i,lookback=60):
    if i<lookback+110:return None
    e7=_ema_at(closes,i,7);e25=_ema_at(closes,i,25);e99=_ema_at(closes,i,99)
    if e7 is None or e25 is None or e99 is None:return None
    if e7>e25 and e25>e99:d='UP'
    elif e7<e25 and e25<e99:d='DOWN'
    else:return None
    price=closes[i]
    if d=='UP':
        hi=max(closes[max(0,i-lookback):i]);e50=_ema_at(closes,i,50) or price
        mom=(price-e50)/e50
        if price>hi and mom>0.01:
            hi25=(price-e25)/e25*100
            lo20=min(closes[max(0,i-19):i+1]);hi20=max(closes[max(0,i-19):i+1])
            pos20=(price-lo20)/(hi20-lo20 or 1)*100
            g20=(price-closes[max(0,i-20)])/closes[max(0,i-20)]*100
            return {'hi25':hi25,'pos20':pos20,'gain20':g20}
    elif d=='DOWN':
        lo=min(closes[max(0,i-lookback):i]);e50=_ema_at(closes,i,50) or price
        mom=(price-e50)/e50
        if price<lo and mom<-0.01:
            lo25=(e25-price)/e25*100
            hi20=max(closes[max(0,i-19):i+1]);lo20=min(closes[max(0,i-19):i+1])
            pos20=(price-lo20)/(hi20-lo20 or 1)*100
            g20=(closes[max(0,i-20)]-price)/closes[max(0,i-20)]*100
            return {'hi25':lo25,'pos20':pos20,'gain20':g20}
    return None

# 统计所有开仓信号的过滤特征分布(找出合理阈值)
SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','FILUSDT','WLDUSDT','XLMUSDT','INJUSDT','SUIUSDT','DOGEUSDT','NEARUSDT','AAVEUSDT']
print('═══ 信号特征分布分析(找合理过滤阈值) ═══\n')
all_hi25=[];all_pos=[];all_gain=[]
cnt=0
for sym in SYMS:
    try:
        kl=get_k(sym,'4h',5)
        if len(kl)<600:continue
        i=170
        while i<len(kl)-5:
            s=signals(kl,i)
            if s:
                cnt+=1
                all_hi25.append(s['hi25']);all_pos.append(s['pos20']);all_gain.append(s['gain20'])
            i+=1
    except:pass

def pct(lst,p):
    lst=sorted(lst)
    return lst[int(len(lst)*p)] if lst else 0

print(f'总开仓信号数: {cnt}')
print()
print('① 价格-BSA25偏离%:')
print(f'  下限={pct(all_hi25,0.05):.1f} 25%分位={pct(all_hi25,0.25):.1f} 中位数={pct(all_hi25,0.5):.1f}')
print(f'  75%分位={pct(all_hi25,0.75):.1f} 90%分位={pct(all_hi25,0.9):.1f} 上限={pct(all_hi25,0.99):.1f}')
print()
print('② 20根位置%(0-100):')
print(f'  中位数={pct(all_pos,0.5):.0f} 75%分位={pct(all_pos,0.75):.0f} 90%分位={pct(all_pos,0.9):.0f}')
print()
print('③ 近20根涨幅%:')
print(f'  中位数={pct(all_gain,0.5):.1f} 75%分位={pct(all_gain,0.75):.1f} 90%分位={pct(all_gain,0.9):.1f}')
