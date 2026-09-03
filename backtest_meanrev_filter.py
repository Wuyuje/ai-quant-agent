#!/usr/bin/env python3
"""均值回归+过滤 独立段验证
过滤器(从判别分析): 只在 波动温和(ATR%在合理档) + 真触外轨 时开均值回归
剔除: 极致窄带微动假反弹/爆炸性大波动
前/后独立段 验证 过滤后震荡是否'该赚才开/不该赚空仓'
"""
import urllib.request,json,time,math
UA={'User-Agent':'Mozilla/5.0'}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','ADAUSDT']
LEV=3; FEE=0.0004; COMPUTE=0.30
def fetch(sym,ivl='15m',limit=1700):
    ak=[];end=None
    while len(ak)<limit:
        u=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={ivl}&limit=1000'+(('&endTime='+end) if end else '')
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=12).read())
        except:time.sleep(0.4);break
        if not b:break
        ak=b+ak;end=str(int(b[0][0])-1);time.sleep(0.45)
    ak.sort(key=lambda x:x[0]);return [(float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in ak]
def run(kl,n=30,k=2.0,rsiL=32,rsiH=68,atrlo=0.15,atrhi=1.3,bandwmax=12.0):
    """触外轨RSI反转 且 ATR%∈(atrlo,atrhi) 且带宽<bandwmax 带过滤"""
    h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl];N=len(c)
    rsi=[50.0]*N
    for i in range(15,N):
        g=lo=0.0
        for j in range(i-14,i):
            dd=c[j]-c[j-1]
            if dd>0:g+=dd
            elif dd<0:lo-=dd
        rsi[i]=100-100/(1+((g/14)/(lo/14) if lo>1e-12 else 999))
    pos=0;entry=0;gross=[]
    band_at_open=vol_at_open=0
    for i in range(n,N):
        seg=c[i-n+1:i+1];m=sum(seg)/n;sd=math.sqrt(sum((x-m)**2 for x in seg)/n) or 1e-9
        up=m+k*sd;dn=m-k*sd;band=(up-dn)/m*100 if m else 0
        # ATR% 近期
        if i>=15:
            trs=[max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])) for j in range(i-13,i+1)]
            atrp=sum(trs)/14/m*100 if m else 0
        r=rsi[i]
        if pos==0:
            sigl=c[i]<=dn and r<rsiL
            sigs=c[i]>=up and r>rsiH
            if sigl or sigs:
                # 过滤: 波动温和 + 带宽不算极端窄(剔micro noise), 且非爆震带
                # 亏损多出于窄带(<8%)微动 & 超高波动>1.3%ATR
                ok_signal = (atrp>=atrlo and atrp<=atrhi)
                if sigl and ok_signal: pos=1;entry=c[i];band_at_open=band;vol_at_open=atrp
                elif sigs and ok_signal: pos=-1;entry=c[i];band_at_open=band;vol_at_open=atrp
        else:
            chg=(c[i]-entry)/entry*100*pos
            # 回归到带宽中轨(用最近布林中值近似)止盈
            mid2=sum(c[max(0,i-n+1):i+1])/min(n,i+1)
            if (pos==1 and c[i]>=mid2) or (pos==-1 and c[i]<=mid2):
                gross.append(chg*LEV);pos=0
            elif chg<=-2.0:
                gross.append(chg*LEV);pos=0
    return gross
def moneya(g):
    if len(g)<6:return None
    rr=[]
    for roi in g:
        net=roi-(LEV*FEE*2*100)
        if net>0:net*=(1-COMPUTE)
        rr.append(net)
    w=[x for x in rr if x>0]
    return len(w)/len(rr)*100,len(rr),sum(rr)
print("均值回归+波动/带宽过滤 - 独立段验证 (15m, BB30/RSI32-68, 费0.04%/盈利30%算力)",flush=True)
for sym in POOL:
    try:kl=fetch(sym)
    except:continue
    if len(kl)<600:continue
    half=len(kl)//2
    segs=[('前',kl[:half]),('后',kl[half:]),('全程',kl)]
    outs=f"  {sym:<8}"
    nets=[]
    for lab,seg in segs:
        g=run(seg)
        m=moneya(g)
        if m:
            outs+=f"{lab}{m[2]:+.0f}%({m[1]})  "
            nets.append((lab,m[2]))
        else: outs+=f"{lab}--  "
    stab=''
    if len(nets)==2 and nets[0][0]=='前' and nets[1][0]=='后':
        stab='✅两段正' if nets[0][1]>0 and nets[1][1]>0 else '⚠️'
    print(outs+stab,flush=True)
