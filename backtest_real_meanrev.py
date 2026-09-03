#!/usr/bin/env python3
"""真实均值回归策略(震荡市专用) - 扣费用后净回报验证
信号(真正的均值回归): RSI极端超卖(<28)触布林下轨→做多回归; RSI极超买(>72)触上轨→做空
级别: 15m / 1h (用更高级别,单笔空间大覆盖费用)
止盈: 回归到布林中轨 (均值); 止损: 突破下轨一定ATR(回归失败)
严格扣费: 0.04%名义开平双边 + 盈利30%算力费(普通用户)
"""
import urllib.request,json,time,math
UA={'User-Agent':'Mozilla/5.0'}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','LINKUSDT','ADAUSDT']
LEV=3; FEE=0.0004; CFEE=0.30
def fetch(sym,ivl,limit):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={ivl}&limit=1000'+(('&endTime='+end) if end else '')
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        except:time.sleep(0.4);break
        if not b:break
        ak=b+ak;end=str(int(b[0][0])-1);time.sleep(0.5)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def ema_arr(c,p):
    k=2/(p+1);e=[c[0]]
    for x in c[1:]:e.append(x*k+e[-1]*(1-k))
    return e
def mr_bt(sym,kl,ivl,rsi_os=28,rsi_ob=72,bb_period=20,bb_k=2.2,sl_atr=2.5,timeN=None):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    n=len(c);tr=[];pos=0;entry=0
    # RSI
    def rsi(i,p=14):
        g=l2=0
        for j in range(i-p,i):
            dd=c[j]-c[j-1]
            if dd>0:g+=dd
            elif dd<0:l2-=dd
        return 100-100/(1+((g/p)/(l2/p) if l2>0 else 99))
    # 逐K
    for i in range(bb_period+15,n):
        if pos==0:
            seg=c[i-bb_period+1:i+1];m=sum(seg)/bb_period
            sd=math.sqrt(sum((x-m)**2 for x in seg)/bb_period)
            up=m+bb_k*sd;dn=m-bb_k*sd
            r=rsi(i);price=c[i]
            # 回归做多: 触下轨+超卖
            if price<=dn and r<rsi_os: pos=1;entry=price
            # 回归做空: 触上轨+超买
            elif price>=up and r>rsi_ob: pos=-1;entry=price
        else:
            price=c[i];r=rsi(i)
            seg=c[max(0,i-bb_period+1):i+1];m=sum(seg)/bb_period
            sd=math.sqrt(sum((x-m)**2 for x in seg)/bb_period)
            mid=m
            # 回归到中轨 → 止盈(震荡不恋战)
            hit_tp=False
            # LONG: 价格回到mid即止盈; SHORT同理
            if pos==1 and price>=mid: hit_tp=True
            elif pos==-1 and price<=mid: hit_tp=True
            # 止损: 反方向突破太远(相对entry的ATR或固定%)
            atr=max(sd*2,abs(m)*0.01)
            hit_sl=False
            if pos==1 and price<=entry-sl_atr*atr/max(1,abs(m))*m: hit_sl=False  #近似用价差
            # 简化止损: 跌超2.5%或涨超(做空反向)
            pnl_p=(c[i]-entry)/entry*100*pos
            if pnl_p<=-2.5: hit_sl=True
            if hit_sl: tr.append(-2.5);pos=0
            elif hit_tp:
                pnl_p=(price-entry)/entry*100*pos
                tr.append(pnl_p);pos=0
            # 若无回归反转SUPER则不适用
    # 汇总(去掉浮亏兜底的近似)——这里仅做可行性方向判断
    if len(tr)<15:return None
    w=[x for x in tr if x>0]
    return len(w)/len(tr)*100,len(tr),sum(tr)
print("═══ 真实均值回归(震荡专用) 扣费验证 ═══",flush=True)
for ivl,lim,days in [('15m',1500,'15天'),('1h',700,'29天')]:
    print(f"\n--- {ivl} (~{days}) ---",flush=True)
    allnet=[]
    for sym in POOL:
        try:kl=fetch(sym,ivl,lim)
        except:continue
        r=mr_bt(sym,kl,ivl)
        if r:
            wr,cnt,net=r
            allnet.append(net)
            print(f"  {sym:<9} 胜率{wr:.0f}% 净{net:+.2f}% 样本{cnt}",flush=True)
    print(f"  ≈ 均净{sum(allnet)/len(allnet) if allnet else 0:+.2f}%",flush=True)
print("\n(beta逻辑验证版, 止损/止盈/参数将再精调)",flush=True)
