#!/usr/bin/env python3
"""震荡策略币池优选 — 实时回测(真实币安数据)
基于 lib/bb-strategy.js 当前配置: 15m周期, 1.5ATR止损, 总浮亏10%, 时间3h, 8/20期布林+SUPERTREND
"""
import json,math,sys,os,urllib.request,time
sys.stdout.reconfigure(line_buffering=True)
UA={'User-Agent':'Mozilla/5.0'}
FEE=0.0008  # 双边0.08%

def get_k(sym,iv,pages=4):
    data=[];et=''
    for _ in range(pages):
        u=f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={iv}&limit=1000'
        if et: u+=f'&endTime={et}'
        try:
            b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=15).read().decode())
        except Exception:
            time.sleep(0.3); continue
        if not b: break
        data=b+data; et=str(b[0][0]); time.sleep(0.04)
    data.sort(key=lambda x:x[0])
    return [{'t':int(x[0]),'o':float(x[1]),'h':float(x[2]),'l':float(x[3]),'c':float(x[4]),'v':float(x[5])} for x in data]

def boll(kl,p=20,s=2.0):
    out=[None]*len(kl)
    for i in range(p-1,len(kl)):
        w=[k['c'] for k in kl[i-p+1:i+1]]
        m=sum(w)/p; sd=math.sqrt(sum((x-m)**2 for x in w)/p)
        out[i]={'mid':m,'up':m+s*sd,'dn':m-s*sd,'sd':sd}
    return out

def atr_c(kl,p=14):
    n=len(kl); out=[0.0]*n
    for i in range(n):
        if i==0: out[i]=kl[i]['h']-kl[i]['l']; continue
        tr=max(kl[i]['h']-kl[i]['l'],abs(kl[i]['h']-kl[i-1]['c']),abs(kl[i]['l']-kl[i-1]['c']))
        out[i]=tr if i<p else (out[i-1]*(p-1)+tr)/p
    return out

def supertrend(kl,p=10,m=3.0):
    n=len(kl)
    if n<p+2: return [None]*n
    a=atr_c(kl,p); hl2=[(k['h']+k['l'])/2 for k in kl]
    up=[0.0]*n; dn=[0.0]*n; d=[1]*n
    for i in range(n):
        u=hl2[i]+m*a[i]; dd=hl2[i]-m*a[i]
        if i>0:
            u=u if (u<up[i-1] or kl[i-1]['c']>up[i-1]) else up[i-1]
            dd=dd if (dd>dn[i-1] or kl[i-1]['c']<dn[i-1]) else dn[i-1]
        up[i]=u; dn[i]=dd
        if i==0: d[i]=1
        elif kl[i]['c']>up[i-1]: d[i]=1
        elif kl[i]['c']<dn[i-1]: d[i]=-1
        else: d[i]=d[i-1] if ((d[i-1]==1 and kl[i]['c']>=dn[i]) or (d[i-1]==-1 and kl[i]['c']<=up[i])) else -d[i-1]
    res=[None]*n
    for i in range(n):
        st=1; j=i
        while j>0 and d[j]==d[j-1]: st+=1; j-=1
        res[i]={'dir':d[i],'prev':d[i-1] if i>0 else d[i],'streak':st}
    return res

def bw_pct(bb,i,lb=100):
    if i<lb: return None
    bws=[]
    for j in range(i-lb,i):
        if bb[j] and bb[j]['mid']: bws.append((bb[j]['up']-bb[j]['dn'])/bb[j]['mid']*100)
    if not bws: return None
    cur=(bb[i]['up']-bb[i]['dn'])/bb[i]['mid']*100
    return sum(1 for x in bws if x<=cur)/len(bws)*100

def bt(sym,kl,opt):
    """震荡策略 v10 回测"""
    bb=boll(kl,opt['bbP'],opt['bbS']); a=atr_c(kl,14)
    st=supertrend(kl,opt['stP'],opt['stM'])
    pos=None;trades=[];pnl=0.0;L=opt['lev'];eq=0;pk=0;dd=0
    for i in range(60,len(kl)):
        k=kl[i];p=k['c'];b=bb[i];s=st[i];at=a[i]
        if not b or not s or not at: continue
        if pos:
            e=pos['entry'];side=pos['side']
            pp=((p-e)/e*100) if side=='LONG' else ((e-p)/e*100)
            roi=pp*L; h=(k['t']-pos['time'])/3600000; er=None
            if pp>=opt['tp']:
                if side=='LONG' and p>=b['up']: er='TP上轨'
                elif side=='SHORT' and p<=b['dn']: er='TP下轨'
                elif pp>=opt['tp']: er='TP兜底'
            if not er:
                if side=='LONG' and p<=e-opt['atrSL']*at: er='SL_ATR'
                elif side=='SHORT' and p>=e+opt['atrSL']*at: er='SL_ATR'
            if not er and roi<=-opt['totalSL']: er='SL总'
            if not er and h>=opt['maxH'] and roi<=-3: er='TIME'
            if not er and s['dir']!=pos['sdir'] and s['prev']!=pos['sdir']: er='SUPER翻转'
            if er:
                pnl_pct=pp/100.0; p_=pnl_pct - FEE*L
                pnl+=p_;eq+=p_;pk=max(pk,eq);dd=max(dd,pk-eq)
                trades.append({'pnl':p_,'reason':er,'roi':roi});pos=None
            continue
        if at/p*100 < 0.10: continue
        bw=bw_pct(bb,i,100)
        if bw and bw>90: continue
        tL=p<=b['dn']; tU=p>=b['up']
        nL=p<=(b['mid']-(b['mid']-b['dn'])*0.6); nU=p>=(b['mid']+(b['up']-b['mid'])*0.6)
        if (tL or nL) and s['dir']==1: pos={'side':'LONG','entry':p,'time':k['t'],'sdir':1}
        elif (tU or nU) and s['dir']==-1: pos={'side':'SHORT','entry':p,'time':k['t'],'sdir':-1}
    return trades,pnl,dd

# 待测币池(含现有池 + 常见币)
SYMS=['BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','LTCUSDT',
      'UNIUSDT','NEARUSDT','ATOMUSDT','SUIUSDT','KASUSDT','XLMUSDT','LITUSDT','SOLUSDT','ORDIUSDT',
      'OPUSDT','TONUSDT','INJUSDT','APTUSDT','TIAUSDT','ARBUSDT','SEIUSDT','BCHUSDT','ONDOUSDT',
      'TRUMPUSDT','1000BONKUSDT','1000PEPEUSDT','HYPEUSDT','TAOUSDT','DOTUSDT','AAVEUSDT','WLDUSDT',
      'PENDLEUSDT','ENAUSDT','FILUSDT','JUPUSDT','STXUSDT','APEUSDT','1000SHIBUSDT']
CACHE="/tmp/btc5/pool15m.json"
if os.path.exists(CACHE):
    D=json.load(open(CACHE)); print(f"缓存:{len(D)}币",flush=True)
else:
    D={}
    for s in SYMS:
        kl=get_k(s,'15m',pages=4)
        if len(kl)>=500: D[s]=kl
        print(f"  {s}: {len(kl)}根",flush=True)
    json.dump(D,open(CACHE,"w"))
n=min(len(v) for v in D.values())
print(f"\n数据: {len(D)}币 x {n}根15m ({n*15/60/24:.0f}天)\n",flush=True)

OPT={'bbP':20,'bbS':2.0,'stP':10,'stM':3.0,'lev':5,'tp':2.0,'atrSL':1.5,'totalSL':10,'maxH':3}
print(f"{'币种':14s} {'笔数':>5} {'胜率':>6} {'盈亏':>9} {'回撤':>7} {'每单':>9}",flush=True)
res=[]
for s,kl in D.items():
    tr,p,dd=bt(s,kl,OPT)
    if not tr: continue
    w=sum(1 for t in tr if t['pnl']>0)
    wr=100*w/len(tr)
    res.append((s,len(tr),wr,p,dd,p/len(tr)))
    time.sleep(0.02)
res.sort(key=lambda x:-x[3])
for s,n_,wr,p,dd,per in res:
    mark=" ✅" if p>0 else " ❌"
    print(f"{s:14s} {n_:5d} {wr:5.1f}% {p:+9.2f} {dd:7.2f} {per:+9.4f}{mark}",flush=True)
print("\n=== 汇总 ===",flush=True)
tot=sum(x[3] for x in res); win=sum(1 for x in res if x[3]>0)
print(f"总盈亏:{tot:+.2f}  盈利币:{win}/{len(res)}",flush=True)
print(f"\n盈利币池(建议): {[x[0] for x in res if x[3]>0]}",flush=True)
print(f"亏损币池(剔除): {[x[0] for x in res if x[3]<=0]}",flush=True)
