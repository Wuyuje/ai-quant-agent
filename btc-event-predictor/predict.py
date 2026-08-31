#!/usr/bin/env python3
"""BTC 10分钟事件预测核心 - 数据+特征+模型+回测
币安事件合约: 买入看涨/看跌, 精确10分钟后判定胜负(base秒级价 vs +600s价)
本脚本: 拉取BTC 1m历史数据缓存 → 建特征 → 训练sklearn模型 → 精确回测胜负率
"""
import urllib.request, json, time, math, os, sys
import numpy as np

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(DATA_DIR, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0'}

def fetch_1m(symbol='BTCUSDT', days=30):
    """拉取指定天数的1mK线, 分页拉到最早, 返回列表[(ts,close,high,low,vol)]"""
    all_k = []
    end = None
    need = days * 1440  # 1天1440根1m
    got = 0
    while got < need:
        url = f'https://data-api.binance.vision/api/v3/klines?symbol={symbol}&interval=1m&limit=1000'
        if end: url += f'&endTime={end}'
        try:
            b = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15).read())
        except Exception as e:
            time.sleep(0.3); continue
        if not b: break
        all_k = b + all_k
        got += len(b)
        end = str(int(b[0][0]) - 1)
        time.sleep(0.1)
        if len(b) < 1000: break   # 到最老数据
    all_k.sort(key=lambda x: x[0])
    return [(int(x[0]), float(x[4]), float(x[2]), float(x[3]), float(x[5])) for x in all_k]

def load_or_fetch(days=30):
    fp = os.path.join(DATA_DIR, f'btc_1m_{days}d.csv')
    if os.path.exists(fp):
        rows = []
        for line in open(fp):
            p = line.strip().split(',')
            rows.append((int(p[0]), float(p[1]), float(p[2]), float(p[3]), float(p[4])))
        print(f"📂 用缓存: {len(rows)}根 1m")
        return rows
    print(f"⬇️ 拉取 BTC 1m {days}天数据...")
    rows = fetch_1m(days=days)
    with open(fp, 'w') as f:
        for r in rows: f.write(f"{r[0]},{r[1]},{r[2]},{r[3]},{r[4]}\n")
    print(f"✅ 已拉取 {len(rows)} 根并缓存")
    return rows

def tech_feats(rows, i):
    """在索引i处算特征: 动量/RSI/MACD/布林/ATR/量比 等"""
    if i < 50: return None
    closes = [r[1] for r in rows[:i+1]]
    highs = [r[2] for r in rows[:i+1]]
    lows = [r[3] for r in rows[:i+1]]
    vols = [r[4] for r in rows[:i+1]]
    c = closes
    p = c[i]
    f = []
    # 动量(3,5,10,15根变化率)
    for n in [3,5,10,15]:
        if i >= n: f.append((p-c[i-n])/(c[i-n] or 1)*100)
        else: f.append(0)
    # RSI(14)
    if i >= 15:
        g=l=0
        for j in range(i-13,i+1):
            d=c[j]-c[j-1]
            if d>0:g+=d
            else:l-=d
        f.append(100-100/(1+(g/l if l>0 else 99)))
    else: f.append(50)
    # 布林位置(20,2)
    if i>=20:
        seg=c[i-20:i]; m=sum(seg)/20
        sd=math.sqrt(sum((x-m)**2 for x in seg)/20)
        up=m+2*sd; lo=m-2*sd
        f.append((p-lo)/((up-lo) or 1)*100)  # 0下轨100上轨
    else: f.append(50)
    # ATR(14) 相对价格
    if i>=14:
        trs=[]
        for j in range(i-13,i+1):
            trs.append(max(highs[j]-lows[j], abs(highs[j]-c[j-1]), abs(lows[j]-c[j-1])))
        atr=sum(trs)/14
        f.append(atr/p*100)
    else: f.append(0)
    # 量比(近5量/前20均量)
    if i>=25:
        vn=sum(vols[i-4:i+1])/5; vp=sum(vols[i-24:i-4])/20
        f.append(vn/vp if vp>0 else 1)
    else: f.append(1)
    # 大级别趋势方向(150根EMA7>25>99=1空=-1)
    if i>=150:
        def ema(a,n):
            k=2/(n+1);e=a[0]
            for x in range(1,len(a)):e=a[x]*k+e*(1-k)
            return e
        e7=ema(c[-150:],7);e25=ema(c[-150:],25);e99=ema(c[-150:],99)
        f.append(1 if e7>e25 and e25>e99 else (-1 if e7<e25 and e25<e99 else 0))
    else: f.append(0)
    return f

def main():
    # 用默认短数据先跑通(5天), 全量可调大
    days = int(sys.argv[1]) if len(sys.argv)>1 else 5
    rows = load_or_fetch(days)
    if len(rows) < 3000:
        print(f"⚠️ 数据不足 {len(rows)} 根, 需要更多"); return
    # 建特征+标签(精确10分钟: i+10根的close vs 当前close, 涨>多 跌>空)
    X, y, ts_idx = [], [], []
    N = 10  # 10根1m = 10分钟后判定
    for i in range(len(rows)-N):
        f = tech_feats(rows, i)
        if f is None: continue
        # 标签: +10分钟价格变化方向(+1涨胜多头, -1跌胜空头)
        p0 = rows[i][1]; p10 = rows[i+N][1]
        label = 1 if p10 > p0 else (-1 if p10 < p0 else 0)
        X.append(f); y.append(label); ts_idx.append(i)
    X = np.array(X); y = np.array(y)
    # 过滤0(平)
    mask = y != 0
    X, y = X[mask], y[mask]
    print(f"样本数: {len(X)} | 涨{pdsum(y==1)} 跌{pdsum(y==-1)}")
    # 训练/测试切分(时间序, 前70%训练后30%测试)
    split = int(len(X)*0.7)
    Xtr, Xte, ytr, yte = X[:split], X[split:], y[:split], y[split:]
    # 模型: 随机森林
    from sklearn.ensemble import RandomForestClassifier
    model = RandomForestClassifier(n_estimators=200, max_depth=8, random_state=42, n_jobs=-1)
    model.fit(Xtr, ytr)
    pred = model.predict(Xte)
    acc = (pred == yte).mean()
    # 方向胜率(只看预测方向的胜率): 预测1时growth胜/预测-1时shr
    long_acc = ((pred==1)&(yte==1)).sum()/max(((pred==1)).sum(),1)
    short_acc = ((pred==-1)&(yte==-1)).sum()/max(((pred==-1)).sum(),1)
    # 高置信度过滤(预测概率>thr才交易)
    proba = model.predict_proba(Xte)
    thr = 0.55
    conf = (proba[:,1]>=thr)|(proba[:,0]>=thr)
    Xc, predc, ytc = Xte[conf], pred[conf], yte[conf]
    accc = (predc==ytc).mean() if len(predc) else 0
    print("")
    print(f"═══ BTC 10分钟涨跌预测回测 ({days}天) ═══")
    print(f"总样本: {len(X)} | 训练{len(Xtr)} 测试{len(Xte)}")
    print(f"整体方向命中率: {acc*100:.1f}%")
    print(f"做多(预测涨)胜率: {long_acc*100:.1f}%")
    print(f"做空(预测跌)胜率: {short_acc*100:.1f}%")
    print(f"高置信度过滤(概率>{thr})后胜率: {accc*100:.1f}% (样本{len(predc)})")
    print(f"⚠️ 目标≥60%才可实盘")

def pdsum(x):
    return int(x.sum()) if hasattr(x,'sum') else sum(1 for v in x if v)

main()
