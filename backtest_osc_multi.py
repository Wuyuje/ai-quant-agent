#!/usr/bin/env python3
"""先进震荡策略 长时间+多币回测
与实盘Node版策略逻辑完全一致: 严震荡(ADX<20+带宽分位<0.4) + RSI反转(<30多/>70空) + TP3ATR/SL1.2ATR/移动止盈
币: 20+主流+山寨 | 时间: 12个月4h
验证: 跨币胜率/回报/回撤稳定性
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
            except: time.sleep(0.3)
        if not ok:break
        if not b:break
        data=b+data;et=str(b[0][0]);time.sleep(0.15)  # 减速防限
    data.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def cb(c,i,p=20,sd=2):
    seg=c[i-p:i];m=sum(seg)/p
    var=sum((x-m)**2 for x in seg)/p;sdv=math.sqrt(var)
    return m+sd*sdv,m,m-sd*sdv
def atr(h,l,c,i,n=14):
    if i<n:return 0.0001
    return sum(max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])) for j in range(i-n,i+1))/n
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
def bpct(c,i,hist=100):
    if i<20:return 0.5
    seg=c[i-20:i];m=sum(seg)/20
    if m<=0:return 0.5
    cur=2*math.sqrt(sum((x-m)**2 for x in seg)/20)/m
    ws=[]
    for j in range(max(20,i-hist),i):
        s=c[j-20:j];mm=sum(s)/20
        if mm>0:ws.append(2*math.sqrt(sum((x-mm)**2 for x in s)/20)/mm)
    return sum(1 for x in ws if x<cur)/len(ws) if ws else 0.5

def backtest(kl,lev=3):
    c=[x[4] for x in kl];h=[x[2] for x in kl];l=[x[3] for x in kl]
    n=len(c);tr=[];i=140;pn=None;eq=1.0;pk=1.0;md=0
    adxM=20;bpM=0.4;tp=3.0;sl=1.2;rsiL=30;rsiS=70;mvA=1.0;mvT=0.7
    while i<n-1:
        price=c[i];a=atr(h,l,c,i)
        up,mid,lo=cb(c,i)
        if pn:
            pct=((price-pn['e'])/pn['e'] if pn['side']=='L' else (pn['e']-price)/pn['e'])*lev
            if pn['side']=='L':
                if price<=pn['e']-sl*a: tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
                if price>=pn['e']+tp*a: tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
                best=pn.get('b',pn['e'])
                if price>best: pn['b']=price
                if best-pn['e']>mvA*a and price<best-mvT*a :tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
            else:
                if price>=pn['e']+sl*a: tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
                if price<=pn['e']-tp*a: tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
                best=pn.get('b',pn['e'])
                if price<best: pn['b']=price
                if pn['e']-best>mvA*a and price>best+mvT*a: tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
            i+=1;continue
        # 严震荡识别
        if adx(h,l,c,i)>adxM or bpct(c,i)>bpM: i+=1;continue
        r=rsi(c,i)
        if price<=lo and r<rsiL: pn={'side':'L','e':price,'b':price};i+=1;continue
        elif price>=up and r>rsiS: pn={'side':'S','e':price,'b':price};i+=1;continue
        i+=1
    if not tr:return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0}
    wins=[x for x in tr if x>0]
    for t in tr: eq*=(1+t);pk=max(pk,eq);md=max(md,(pk-eq)/pk)
    return {'t':len(tr),'w':len(wins),'wr':round(len(wins)*100/len(tr),1),'ret':round((eq-1)*100,2),'maxdd':round(md*100,2)}

# 20+主流+山寨币
SYMS=['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','DOTUSDT',
      'UNIUSDT','LTCUSDT','BCHUSDT','NEARUSDT','APTUSDT','SUIUSDT','ARBUSDT','OPUSDT','INJUSDT','SEIUSDT',
      'AAVEUSDT','FILUSDT','RNDRUSDT','IMXUSDT']
P4=60

def main():
    print('═══ 先进震荡策略 长时间+多币回测(24币12月4h) ═══',flush=True)
    print('═══ 严震荡(ADX20+带0.4)+RSI反转+TP3/SL1.2ATR ═══\n',flush=True)
    agg={'t':0,'w':0,'ret':0.0,'md':0.0}
    pos_cnt=0; neg_cnt=0
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)<400: print(f'  {sym} 数据不足({len(kl)})');continue
            r=backtest(kl)
            flag='✅' if r['ret']>0 else '❌'
            if r['ret']>0: pos_cnt+=1
            else: neg_cnt+=1
            print(f"  {flag} {sym:<10} {r['t']:3}笔 胜{r['wr']:4.1f}% 回报{r['ret']:+6.1f}% 回撤{r['maxdd']:4.1f}%",flush=True)
            agg['t']+=r['t'];agg['w']+=r['w'];agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        except Exception as e: print(f'  {sym}: {e}',flush=True)
    wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
    print('',flush=True)
    print(f"═══ 汇总: 币数{len(SYMS)} 正回报{pos_cnt}个/负{neg_cnt}个 | {agg['t']}笔 胜率{wr}% 累加回报{agg['ret']:+.0f}% 最大回撤{agg['md']:.1f}% ═══",flush=True)

main()
