#!/usr/bin/env python3
"""双策略(趋势波段+布林顺势)配合回测 - 预计算高性能版
配合逻辑: 每币趋势波段(4h)优先; 无趋势信号→落布林(4h顺势门禁); 同币互斥; 趋势5仓+布林5仓独立
输出: 合并资金曲线/回撤/名义敞口(验证双策略配合是否敞口失控)
"""
import urllib.request,json,time,math,sys

UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0005

def get_k(sym,iv,pages):
    data=[];et=''
    for _ in range(pages):
        url=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et:url+=f'&endTime={et}'
        req=urllib.request.Request(url,headers=UA)
        ok=False
        for a in range(3):
            try:
                b=json.loads(urllib.request.urlopen(req,timeout=15).read().decode());ok=True;break
            except: time.sleep(0.25)
        if not ok:break
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.04)
    data.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def precompute(kl):
    """预计算所有指标数组, 供O(1)索引"""
    n=len(kl)
    c=[x[4] for x in kl]; h=[x[2] for x in kl]; l=[x[3] for x in kl]
    # EMA 数组
    def ema_arr(p):
        out=[0.0]*n; k=2/(p+1); e=c[0]
        for i in range(n):
            if i==0: e=c[0]
            else: e=c[i]*k+e*(1-k)
            out[i]=e
        return out
    e7=ema_arr(7); e25=ema_arr(25); e99=ema_arr(99); e50=ema_arr(50)
    # ATR 数组
    atr=[0.0]*n; trs=[]
    for i in range(1,n):
        trs.append(max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1])))
        if i>=14: atr[i]=sum(trs[i-14:i])/14
        else: atr[i]=sum(trs)/len(trs)
    # 布林带数组(20,2)
    up=[0.0]*n; lo=[0.0]*n; mid=[0.0]*n
    for i in range(20,n):
        seg=c[i-20:i]; m=sum(seg)/20
        var=sum((x-m)**2 for x in seg)/20; sdv=math.sqrt(var)
        mid[i]=m; up[i]=m+2*sdv; lo[i]=m-2*sdv
    # 前60高低(滚动最值, 用前缀近似简化: 用滑动)
    hi60=[0.0]*n; lo60=[1e18]*n
    from collections import deque
    mh=deque(); ml=deque()
    for i in range(n):
        # 维护 60 窗口
        if i>=60:
            pass
        # 简化: 用 numpy-free 滑动窗口, 为性能用简单循环(只对可能信号点算)
    return {'c':c,'h':h,'l':l,'e7':e7,'e25':e25,'e99':e99,'e50':e50,
            'atr':atr,'up':up,'lo':lo,'mid':mid,'n':n}

def trend_sig_at(pc,i):
    """趋势波段信号 O(1): 需要前60高低, 这里预计算窗口"""
    if i<100: return 'NONE'
    if pc['e7'][i]>pc['e25'][i] and pc['e25'][i]>pc['e99'][i]:
        hi60=max(pc['c'][max(0,i-60):i])
        mom=(pc['c'][i]-pc['e50'][i])/(pc['e50'][i] or 1)
        if pc['c'][i]>hi60 and mom>0.01: return 'LONG'
    elif pc['e7'][i]<pc['e25'][i] and pc['e25'][i]<pc['e99'][i]:
        lo60=min(pc['c'][max(0,i-60):i])
        mom=(pc['c'][i]-pc['e50'][i])/(pc['e50'][i] or 1)
        if pc['c'][i]<lo60 and mom<-0.01: return 'SHORT'
    return 'NONE'

def boll_sig_at(pc,i):
    """布林触轨信号 O(1)"""
    if i<20 or pc['up'][i]<=pc['lo'][i]: return 'NONE'
    if pc['c'][i]<=pc['lo'][i]: return 'LONG'
    if pc['c'][i]>=pc['up'][i]: return 'SHORT'
    return 'NONE'

def boll_gate_at(pc,i,sig,maxspread=3):
    """布林趋势方向门禁 O(1): UP只多/DOWN只空/FLAT不开/强趋势回避"""
    if i<60: return False
    e7,e25,e99=pc['e7'][i],pc['e25'][i],pc['e99'][i]
    if e7>e25 and e25>e99: d='UP'
    elif e7<e25 and e25<e99: d='DOWN'
    else: return False
    spread=abs(e7-e25)/(e25 or 1)*100
    if spread>maxspread: return False
    if (d=='UP' and sig=='LONG') or (d=='DOWN' and sig=='SHORT'): return True
    return False

def run_dual(profile, data):
    """data: dict{sym: precompute结果}. 已对齐长度"""
    syms=list(data.keys())
    n=min(data[s]['n'] for s in syms)
    bal=profile['balance']; lev=profile['lev']; pct=profile['posPct']
    tmax=profile['trendMax']; bmax=profile['bollMax']
    pos={}; eq=bal; peak=bal; maxdd=0
    exposures=[]; trend_pos=boll_pos=0
    trend_trades=[]; boll_trades=[]
    for i in range(150,n-1):
        # 1) 管理持仓
        for sym in list(pos.keys()):
            p=pos[sym]; pc=data[sym]
            price=pc['c'][i]; atr=pc['atr'][i]
            if p['strat']=='trend':
                # 两阶段锁利
                pnl=(price-p['entry'])/p['entry'] if p['side']=='LONG' else (p['entry']-price)/p['entry']
                pnl_pct=pnl*100
                if p['side']=='LONG':
                    if price>p['best']: p['best']=price
                    if pnl_pct>=2.0: stop=p['best']*(1-1.0/100)
                    else: stop=max(p['entry']-0.8*atr,p['best']-0.7*atr)
                    tp=p['entry']+2.0*atr
                    act='CLOSE' if (price<=stop or price>=tp) else 'HOLD'
                else:
                    if price<p['best']: p['best']=price
                    if pnl_pct>=2.0: stop=p['best']*(1+1.0/100)
                    else: stop=min(p['entry']+0.8*atr,p['best']+0.7*atr)
                    tp=p['entry']-2.0*atr
                    act='CLOSE' if (price>=stop or price<=tp) else 'HOLD'
            else:
                # 布林: 止盈(浮盈1%触中轨/上轨) 硬止损20%
                pnl=(price-p['entry'])/p['entry'] if p['side']=='LONG' else (p['entry']-price)/p['entry']
                if p['side']=='LONG':
                    act='CLOSE' if (pnl>=0.01 and price>=pc['mid'][i]) or pnl<=-0.20 or price>=pc['up'][i] else 'HOLD'
                else:
                    act='CLOSE' if (pnl>=0.01 and price<=pc['mid'][i]) or pnl<=-0.20 or price<=pc['lo'][i] else 'HOLD'
            if act=='CLOSE':
                eq+=p['notional']*pnl
                if p['strat']=='trend': trend_pos-=1; trend_trades.append(pnl)
                else: boll_pos-=1; boll_trades.append(pnl)
                del pos[sym]
        # 2) 开新仓
        for sym in syms:
            if sym in pos: continue
            if trend_pos>=tmax and boll_pos>=bmax: break
            pc=data[sym]
            tsig=trend_sig_at(pc,i)
            if tsig!='NONE' and trend_pos<tmax:
                notional=bal*pct*3
                pos[sym]={'strat':'trend','side':tsig,'entry':pc['c'][i],'best':pc['c'][i],'notional':notional}
                trend_pos+=1; continue
            bsig=boll_sig_at(pc,i)
            if bsig!='NONE' and boll_pos<bmax and boll_gate_at(pc,i,bsig):
                notional=max(20,bal*pct*3)
                pos[sym]={'strat':'boll','side':bsig,'entry':pc['c'][i],'best':pc['c'][i],'notional':notional}
                boll_pos+=1
        # 3) 敞口/权益
        ne=sum(p['notional'] for p in pos.values())
        exposures.append(ne/eq if eq>0 else 0)
        if eq>peak: peak=eq
        dd=(peak-eq)/peak
        if dd>maxdd: maxdd=dd
    return {
      'final':eq,'retPct':(eq/bal-1)*100,'maxddPct':maxdd*100,
      'avgExposure':sum(exposures)/len(exposures) if exposures else 0,
      'peakExposure':max(exposures) if exposures else 0,
      'trendTrades':len(trend_trades),'bollTrades':len(boll_trades),
      'trendWr':(sum(1 for x in trend_trades if x>0)/len(trend_trades)*100) if trend_trades else 0,
      'bollWr':(sum(1 for x in boll_trades if x>0)/len(boll_trades)*100) if boll_trades else 0,
      'trendRet':sum(trend_trades)*100,'bollRet':sum(boll_trades)*100,
    }

SYMS=['TAOUSDT','SOLUSDT','APTUSDT','DOGEUSDT','ADAUSDT','JUPUSDT',
      'BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','DOTUSDT','UNIUSDT',
      'OPUSDT','ARBUSDT','SUIUSDT','NEARUSDT','AAVEUSDT','BCHUSDT','ENAUSDT','WLDUSDT']
PROFILES={'admin':{'balance':713.0,'lev':3,'posPct':0.12,'trendMax':5,'bollMax':5},
          'small':{'balance':100.0,'lev':5,'posPct':0.20,'trendMax':5,'bollMax':5}}

def main():
    print('═══ 双策略(趋势波段+布林顺势)配合回测 - 预计算版 ═══',flush=True)
    print('═══ 币: 持仓池+主流%d | 4h | 趋势优先/布林补充/同币互斥/独立5仓 ═══\n'%len(SYMS),flush=True)
    data={}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',27)
            if len(kl)<300: continue
            data[sym]=precompute(kl)
            print(f'  载入 {sym}: {len(kl)}根',flush=True)
        except Exception as e:
            print(f'  {sym} 失败: {str(e)[:40]}',flush=True)
    print(f'\n共载入 {len(data)} 币\n',flush=True)
    for pname,prof in PROFILES.items():
        r=run_dual(prof,data)
        print(f'═══ 账户 {pname}(余额${prof["balance"]:.0f} {prof["lev"]}x) ═══',flush=True)
        print(f'  末期权益 ${r["final"]:.0f} | 总回报{r["retPct"]:+.1f}% | 最大回撤{r["maxddPct"]:.1f}%',flush=True)
        print(f'  名义敞口: 均值{r["avgExposure"]*100:.0f}% / 峰值{r["peakExposure"]*100:.0f}%(总权益倍数)',flush=True)
        print(f'  趋势:{r["trendTrades"]}笔 胜{r["trendWr"]:.0f}% 累加{r["trendRet"]:+.1f}% | 布林:{r["bollTrades"]}笔 胜{r["bollWr"]:.0f}% 累加{r["bollRet"]:+.1f}%',flush=True)
        print('',flush=True)

if __name__=='__main__':
    main()
