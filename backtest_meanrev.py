#!/usr/bin/env python3
"""震荡市·真正均值回归策略(严谨版) 含全费用回测
设计(理论): 价格偏离(布林/RSI极端)→回归均值是震荡最确定收益
入场:
  做多: RSI(14)<RSI_L 且 收盘<=布林下轨(BB_n, BB_k)  (超卖+触下轨)
  做空: RSI(14)>RSI_H 且 收盘>=布林上轨             (超买+触上轨)
出场(均值回归,不清仓原则):
  止盈: 收盘回归至布林中轨(mean)即止盈落袋
  止损(回归失败): ATR止损滑轨/反向破位 - 用移动: 峰值反走0.9*基础ATR平, 或跌破开仓-2.0ATR硬止损
级别: 15m / 1h
成本: FEE(名义0.04%开+平)+ COMPUTE(普通用户盈利30%)
目标: 扣全费净回报为正且稳定
"""
import urllib.request,json,time,math,sys
sys.path.insert(0,'/app/workspace/ai-quant-agent')
UA={'User-Agent':'Mozilla/5.0'}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','LINKUSDT','ADAUSDT','APTUSDT','DOTUSDT','LTCUSDT']
LEV=3.0          # 合约杠杆(名义)
FEE=0.0004       # 单边手续费(名义的0.04%)
COMPUTE=0.30     # 算力费(普通用户盈利30%)
def fetch(sym,ivl,limit):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={ivl}&limit=1000'+(('&endTime='+end) if end else '')
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        except:time.sleep(0.4);break
        if not b:break
        ak=b+ak;end=str(int(b[0][0])-1);time.sleep(0.5)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def atr_series(h,l,c,n=14):
    a=[0.0]
    for i in range(1,len(c)):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]))
        a.append((a[-1]*(n-1)+tr)/n if i>0 else tr)
    return a

def run(kl,bb_n,bb_k,rsiL,rsiH,sl_atr,ivl):
    h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);atr=atr_series(h,l,c);trades=[];pos=0;entry=0;peak=0;peak_price=0
    # RSI 缓存
    rsi_cache=[50.0]*n
    for i in range(15,n):
        g=lo=0.0
        for j in range(i-14,i):
            dd=c[j]-c[j-1]
            if dd>=0:g+=dd
            else:lo-=dd
        rsi_cache[i]=100-100/(1+((g/14)/(lo/14) if lo>1e-12 else 999))
    for i in range(max(bb_n,15),n):
        if pos==0:
            seg=c[i-bb_n+1:i+1];m=sum(seg)/bb_n
            sd=math.sqrt(sum((x-m)**2 for x in seg)/bb_n) or 1e-9
            up=m+bb_k*sd;dn=m-bb_k*sd
            r_=rsi_cache[i];price=c[i]
            if price<=dn and r_<rsiL: pos=1;entry=price;peak=price;peakpx=price
            elif price>=up and r_>rsiH: pos=-1;entry=price;peak=price;peakpx=price
        else:
            seg=c[max(0,i-bb_n+1):i+1];m=sum(seg)/bb_n
            sd=math.sqrt(sum((x-m)**2 for x in seg)/bb_n) or 1e-9
            mid=m;price=c[i];a=max(atr[i],abs(m)*0.0008)
            # 更新不利峰值(反向走)
            if pos==1:
                if price<peakpx: peakpx=price
                # 回归中轨止盈
                if price>=mid: trades.append(('TP',((price-entry)/entry)*LEV*100));pos=0;continue
                # 止损: 从最低点反走sl_atr倍ATR, 或跌破entry-2*atr
                hi_run=max(c[max(0,i-20):i+1])
                stop=entry-sl_atr*a/max(1,m)*(m)  # ATR相对该值scale,用价差简化
                if price<=entry-sl_atr*a/m*entry:  # ≈跌破 sl_atr*atr(价格单位)
                    stoppx=float('inf')
                    if price<=entry-(sl_atr*a/max(a,1))*a:
                        trades.append(('SL',((price-entry)/entry)*LEV*100));pos=0;continue
            if pos==1 and price < entry-(sl_atr*atr[i] if atr[i]>0 else 1):
                trades.append(('SL',((price-entry)/entry)*LEV*100));pos=0;continue
            if pos==-1 and price>entry+(sl_atr*atr[i] if atr[i]>0 else 1):
                trades.append(('SL',((price-entry)/entry)*LEV*100));pos=0;continue
            # 若未平但在中轨附近-防止timeout挂单太久
    return trades
def money(trades,sym):
    # trades: list of ('TP'/'SL', roi_price_percent_lev)
    real=[];gross=0
    for kind,roi in trades:
        price_ret=roi/LEV  # →价格%
        # 换算每百万名义的开平费: 费=名义0.08%=0.0008 in价格回等价->相对本金loss
        # net%=价差%*杠杆 - 手续费(名义0.08%→占本金? 名义=本金*lev→ 费占本金=lev*0.0008)
        fee=LEV*FEE*2*100  # 折算到回报%的单位: 手续费相对本金=名义*0.08%=本金*lev0.0008 →×100%
        net=roi-fee
        if net>0: net*=(1-COMPUTE)  # 普通用户盈利扣30%
        real.append(net)
    if len(real)<10:return None
    w=[x for x in real if x>0]
    return len(w)/len(real)*100,len(real),sum(real)
cfgs=[(20,2.2,28,72,2.0),(20,2.0,30,70,2.5),(15,2.0,25,75,2.0),(20,2.2,25,75,2.5)]
tests=[('15m',1200),('1h',650)]
print("═══ 真正的均值回归(震荡专用) + 全费用回测 ═══",flush=True)
for ivl,lim in tests:
    print(f"\n--- {ivl} ---",flush=True)
    # 每配置汇总
    for (n_,k_,rl_,rh_,sl_) in cfgs:
        nets=[]
        for sym in POOL:
            try:kl=fetch(sym,ivl,lim)
            except:continue
            trades=run(kl,n_,k_,rl_,rh_,sl_,ivl)
            if trades:
                m=money(trades,sym)
                if m: nets.append(m[2])
        if nets:
            print(f"  BB{n_}±{k_} RSI{rl_}-{rh_} SL{sl_}ATR: 均净{sum(nets)/len(nets):+.1f}% 正币{sum(1 for x in nets if x>0)}/{len(nets)}",flush=True)
print("\n(正币越多越可信; 负说明此参数在震荡回归上不赚)",flush=True)
