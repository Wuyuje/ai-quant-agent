#!/usr/bin/env python3
"""先进震荡策略 参数网格优化回测
目标: 胜率>=55% + 回报正 + 回撤降到<35%
变量: ADX阈值 / 带宽分位阈 / 止盈:止损比例 / 单笔风险
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
        data=b+data;et=str(b[0][0]);time.sleep(0.02)
    data.sort(key=lambda x:x[0])
    return [(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in data]

def cb(c,i,p=20,sd=2):
    seg=c[i-p:i];m=sum(seg)/p
    var=sum((x-m)**2 for x in seg)/p;sdv=math.sqrt(var)
    return m+sd*sdv,m,m-sd*sdv
def atr(h,l,c,i,n=14):
    if i<n:return 0.0001
    t=[max(h[j]-l[j],abs(h[j]-c[j-1]),abs(l[j]-c[j-1])) for j in range(i-n,i+1)]
    return sum(t)/len(t)
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

def bt(kl,cfg):
    adxM=cfg['adxM'];bpM=cfg['bpM'];tpM=cfg['tpM'];slM=cfg['slM'];risk=cfg['risk'];lev=3
    c=[x[4] for x in kl];h=[x[2] for x in kl];l=[x[3] for x in kl]
    n=len(c);tr=[];i=140;pn=None;eq=1.0;pk=1.0;md=0
    while i<n-1:
        price=c[i];a=atr(h,l,c,i)
        up,mid,lo=cb(c,i)
        if pn is not None:
            pct=((price-pn['e'])/pn['e'] if pn['side']=='L' else (pn['e']-price)/pn['e'])*lev
            if pn['side']=='L':
                if price<=pn['e']-slM*a: tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
                if price>=pn['e']+tpM*a: tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
                if price>pn.get('b',pn['e']):pn['b']=price
                if pn['b']-pn['e']>1.0*a and price<pn['b']-0.7*a:tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
            else:
                if price>=pn['e']+slM*a: tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
                if price<=pn['e']-tpM*a: tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
                if price<pn.get('b',pn['e']):pn['b']=price
                if pn['e']-pn['b']>1.0*a and price>pn['b']+0.7*a:tr.append(pct-2*FEE);eq*=(1+pct);pn=None;i+=1;continue
            i+=1;continue
        if adx(h,l,c,i)>adxM or bpct(c,i)>bpM: i+=1;continue
        r=rsi(c,i)
        if price<=lo and r<30: pn={'side':'L','e':price,'b':price};i+=1;continue
        elif price>=up and r>70: pn={'side':'S','e':price,'b':price};i+=1;continue
        i+=1
    if not tr:return {'t':0,'w':0,'wr':0,'ret':0.0,'maxdd':0.0,'pr':0}
    wins=[x for x in tr if x>0];loss=[x for x in tr if x<=0]
    for t in tr: eq*=(1+t);pk=max(pk,eq);md=max(md,(pk-eq)/pk)
    return {'t':len(tr),'w':len(wins),'wr':round(len(wins)*100/len(tr),1),'ret':round((eq-1)*100,2),'maxdd':round(md*100,2),
            'pr':round(abs(sum(wins)/len(wins)/(sum(loss)/len(loss))),2) if loss else 99}

SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','AVAXUSDT']
P4=60
GRID=[
 ('初版(ADX25/bp0.5/tp2.5/sl1.5/risk1%)',{'adxM':25,'bpM':0.5,'tpM':2.5,'slM':1.5,'risk':0.01}),
 ('更严震荡(ADX20/bp0.4)',{'adxM':20,'bpM':0.4,'tpM':2.5,'slM':1.5,'risk':0.01}),
 ('高盈亏比(ADX25/bp0.5/tp3/sl1.2)',{'adxM':25,'bpM':0.5,'tpM':3.0,'slM':1.2,'risk':0.01}),
 ('低风险(risk0.5%)',{'adxM':25,'bpM':0.5,'tpM':2.5,'slM':1.5,'risk':0.005}),
 ('严震荡+高盈亏比',{'adxM':20,'bpM':0.4,'tpM':3.0,'slM':1.2,'risk':0.008}),
 ('快止盈保胜率(ADX25/tp1.8/sl1.5)',{'adxM':25,'bpM':0.5,'tpM':1.8,'slM':1.5,'risk':0.01}),
]
def main():
    print('═══ 先进震荡策略 参数网格优化 ═══',flush=True)
    print('═══ 6币 | 目标: 胜率>=55% 回报正 回撤<35% ═══\n',flush=True)
    bars={}
    for sym in SYMS:
        try:
            kl=get_k(sym,'4h',P4)
            if len(kl)>400: bars[sym]=kl
        except:pass
    print(f'载入{len(bars)}币\n',flush=True)
    for label,cfg in GRID:
        agg={'t':0,'w':0,'ret':0.0,'md':0.0}
        for sym,kl in bars.items():
            r=bt(kl,cfg)
            agg['t']+=r['t'];agg['w']+=r['w'];agg['ret']+=r['ret'];agg['md']=max(agg['md'],r['maxdd'])
        wr=round(agg['w']*100/agg['t'],1) if agg['t'] else 0
        pr='-'
        print(f"  {label:<22} {agg['t']:3}笔 胜{wr:4.1f}% 回报{agg['ret']:+6.1f}% 回撤{agg['md']:4.1f}%",flush=True)
main()
