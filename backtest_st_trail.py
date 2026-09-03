#!/usr/bin/env python3
"""SuperTrend反转 + 移动止盈 vs 固定止盈 回测
入场: SUPER(10,3)翻转点反转开仓
出场对比:
  mode=TRAIL: 移动止盈(盈利达act%后, 回撤trail%平) + 固定止损SL%
  mode=FIX:   固定止盈TP% + 固定止损SL%
止损统一收紧到1.0%
多币验证 → 找最优(移动止盈参数/固定止盈)
"""
import urllib.request,json,time,math,sys
sys.path.insert(0,'/app/workspace/ai-quant-agent')
UA={'User-Agent':'Mozilla/5.0'}
def fetch(sym,interval='5m',limit=3000):
    all_k=[];end=None;need=limit
    while len(all_k)<need:
        url=f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={interval}&limit=1000'
        if end:url+=f'&endTime={end}'
        try:b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
        except:time.sleep(0.35);continue
        if not b:break
        all_k=b+all_k;end=str(int(b[0][0])-1);time.sleep(0.6)
    all_k.sort(key=lambda x:x[0])
    return [(float(x[1]),float(x[2]),float(x[3]),float(x[4]),float(x[5])) for x in all_k]
def supertrend(h,l,c,p=10,m=3.0):
    n=len(c);atr=[0.0]*n
    for i in range(1,n):
        tr=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]));atr[i]=(atr[i-1]*(p-1)+tr)/p if i>=p else tr
    hl2=[(h[i]+l[i])/2 for i in range(n)];up=[0.0]*n;dn=[0.0]*n;d=[1]*n
    for i in range(n):
        u=hl2[i]+m*atr[i];dd=hl2[i]-m*atr[i]
        if i>0:
            u=u if (u<up[i-1] or c[i-1]>up[i-1]) else up[i-1]
            dd=dd if (dd>dn[i-1] or c[i-1]<dn[i-1]) else dn[i-1]
        up[i]=u;dn[i]=dd
    for i in range(1,n):
        if c[i]>up[i-1]:d[i]=1
        elif c[i]<dn[i-1]:d[i]=-1
        elif d[i-1]==1:d[i]=1 if c[i]>=dn[i] else -1
        else:d[i]=-1 if c[i]<=up[i] else 1
    return d
def run_trail(kl,sl,tp_act,trail):
    """移动止盈: 盈利达tp_act后, 回撤trail平; 止损sl"""
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c)
    trades=[];pos=0;entry=0;peak=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i];peak=entry
        else:
            # 更新峰值
            if pos==1: peak=max(peak,h[i])
            else: peak=min(peak,l[i])
            mvt=(peak-entry)/entry*pos  # 正向移动量
            # 止损
            hit_sl=(l[i]<=entry*(1-sl) and pos==1) or (h[i]>=entry*(1+sl) and pos==-1)
            # 移动止盈: 已盈利≥act% 后, 回撤trail% 平
            trail_hit=False
            if mvt>=tp_act:
                if pos==1 and l[i]<=peak*(1-trail): trail_hit=True
                elif pos==-1 and h[i]>=peak*(1+trail): trail_hit=True
            if hit_sl: trades.append(-sl*100);pos=0
            elif trail_hit:
                # 按当前收盘估算(移动止盈平仓价近似峰值回撤后)
                p=peak*(1-trail) if pos==1 else peak*(1+trail)
                trades.append(((p-entry)/entry)*100*pos);pos=0
            elif d[i]!=d[i-1]:
                trades.append(((c[i]-entry)/entry)*100*pos);pos=0
    if pos!=0: trades.append(((c[-1]-entry)/entry)*100*pos)
    if len(trades)<15:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
def run_fix(kl,sl,tp):
    o=[x[0] for x in kl];h=[x[1] for x in kl];l=[x[2] for x in kl];c=[x[3] for x in kl]
    d=supertrend(h,l,c);n=len(c);trades=[];pos=0;entry=0
    for i in range(1,n):
        if pos==0:
            if d[i]!=d[i-1]: pos=-d[i];entry=c[i]
        else:
            hit_tp=(h[i]>=entry*(1+tp) and pos==1) or (l[i]<=entry*(1-tp) and pos==-1)
            hit_sl=(l[i]<=entry*(1-sl) and pos==1) or (h[i]>=entry*(1+sl) and pos==-1)
            if hit_sl: trades.append(-sl*100);pos=0
            elif hit_tp: trades.append(tp*100);pos=0
            elif d[i]!=d[i-1]: trades.append(((c[i]-entry)/entry)*100*pos);pos=0
    if pos!=0:trades.append(((c[-1]-entry)/entry)*100*pos)
    if len(trades)<15:return None
    wins=[x for x in trades if x>0]
    return {'acc':len(wins)/len(trades)*100,'n':len(trades),'net':sum(trades)}
POOL=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','XRPUSDT','ADAUSDT','LINKUSDT','LTCUSDT','SUIUSDT','ARBUSDT']
# 配置
confs=[
    ('固定TP1.5%',lambda kl: run_fix(kl,0.010,0.015)),
    ('移动 act1%回撤0.6%',lambda kl: run_trail(kl,0.010,0.010,0.006)),
    ('移动 act1%回撤0.8%',lambda kl: run_trail(kl,0.010,0.010,0.008)),
    ('移动 act1.5%回撤0.8%',lambda kl: run_trail(kl,0.010,0.015,0.008)),
    ('移动 act2%回撤1%',lambda kl: run_trail(kl,0.010,0.020,0.010)),
    ('移动 act1%回撤0.5%',lambda kl: run_trail(kl,0.010,0.010,0.005)),
]
print(f"{'币':<9}"+''.join(f"  {name[:9]}" for name,_ in confs),flush=True)
netmap=[[] for _ in confs]
for sym in POOL:
    try: kl=fetch(sym)
    except: continue
    line=f"  {sym[:7]}"
    for si,(_,fn) in enumerate(confs):
        r=fn(kl)
        if r: netmap[si].append(r['net']);line+=f"  {r['acc']:3.0f}%/{r['net']:+5.1f}%".replace('%','%',1)
        else: line+="   --/--"
    print(line,flush=True)
print("\n=== 各止盈方式平均净盈亏 (止损统一1.0%) ===",flush=True)
for si,(name,_) in enumerate(confs):
    arr=netmap[si]
    if arr:
        pos_n=sum(1 for x in arr if x>0)
        print(f"  {name:<18}: 平均净{sum(arr)/len(arr):+.2f}%  {pos_n}/{len(arr)}币盈利",flush=True)
