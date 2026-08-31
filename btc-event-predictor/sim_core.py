#!/usr/bin/env python3
"""BTC 10分钟事件预测 模拟盘核心引擎
独立系统, 复用量化用户配置(APIkey提示用). 只模拟, 不实盘.
流程: 每60秒安全拉BTC 1s近期数据 → 秒级微观特征 → 预测未来10分钟涨/跌+置信度
     高置信度(≥0.1)时模拟开仓(虚拟资金), 10分钟后判定胜负 → 统计胜率/资金
"""
import urllib.request,json,time,os,sys,math,datetime
import threading
UA={'User-Agent':'Mozilla/5.0'}
DATA_DIR=os.path.dirname(os.path.abspath(__file__))
STATE_FILE=os.path.join(DATA_DIR,'sim_state.json')
LOOKBACK=300; HORIZON=600; MIN_USDT=50; TRADE_USDT=10
CONF_THRESHOLD=0.10

def fetch_1s_recent(seconds=700):
    """安全拉最近的1s数据(700秒≈12分钟覆盖一个10分钟窗口)"""
    url=f'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=1000&startTime={int(time.time()*1000)-seconds*1000}'
    try:
        b=json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=12).read())
    except: return []
    return [(int(x[0]),float(x[4]),float(x[2]),float(x[3]),float(x[5])) for x in b]

def micro_feats(secs):
    c=[x[1] for x in secs];h=[x[2] for x in secs];l=[x[3] for x in secs];v=[x[4] for x in secs]
    if len(c)<60: return None
    f=[]
    ups=sum(1 for i in range(1,len(c)) if c[i]>c[i-1]);dns=len(c)-1-ups
    f.append(ups/(len(c)-1)); f.append((ups-dns)/(len(c)-1))
    upv=sum(v[i] for i in range(1,len(c)) if c[i]>c[i-1])
    f.append(upv/(sum(v[1:]) or 1))
    win=60; f.append((c[-1]-c[-win])/(c[-win] or 1)*100)
    segs=[(c[s+5]-c[s])/(c[s] or 1)*100 if s+5<len(c) else 0 for s in range(0,min(150,len(c)-1),5)]
    f.append(sum(segs)/max(len(segs),1)); f.append(max(segs) if segs else 0); f.append(min(segs) if segs else 0)
    f.append(sum(1 for x in segs if x>0)/max(len(segs),1))
    f.append((c[-1]-c[0])/(c[0] or 1)*100)
    hi=max(c[-60:]);lo=min(c[-60:])
    f.append((c[-1]-lo)/((hi-lo) or 1)*100)
    f.append(sum(v[-10:])/(sum(v[-30:]) or 1) if len(v)>=30 else 1)
    trs=[max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1])) for i in range(1,len(c))]
    f.append(sum(trs[-60:])/60/(c[-1] or 1)*100)
    return f

# 简易统计预测器(无需重训): 用方向动量+成交失衡打分 → 预测概率
def predict(f):
    """f[0]:上升秒占比, f[1]:净方向(-1..1), f[2]:阳线量占比, f[3]:近60s动量%, f[8]:累积动量"""
    score=0
    # 上升秒占比>0.52→偏涨
    score += (f[0]-0.5)*4
    # 净方向
    score += f[1]*2
    # 阳线量占比
    score += (f[2]-0.5)*3
    # 近60s动量
    score += max(-3,min(3,f[3]))*2
    # 累积动量(近窗口)
    score += max(-2,min(2,f[8]))
    prob=1/(1+math.exp(-score))   # 映射到[0,1] = 涨概率
    return prob

def init_state(users):
    state={'users':{},'trades':[],'open':None}
    for w in users:
        state['users'][w]={'balance':100.0,'wins':0,'losses':0,'equity_curve':[100.0]}
    return state

def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f: return json.load(f)
        except: pass
    # 从量化系统读用户(模拟盘所有用户共用一个池? 这里每个用户独立虚拟资金)
    users=[]
    try:
        q=json.load(open('/app/workspace/ai-quant-agent/data/saas-users.json'))
        for w in q:
            if '0x' in w: users.append(w)
    except: users=[]
    return init_state(users)

def save_state(state):
    with open(STATE_FILE,'w') as f: json.dump(state,f)

def tick(state):
    """一轮: 拉数据→预测→若开放仓/判定"""
    rows=fetch_1s_recent(800)
    if len(rows)<300:
        return '数据不足'
    f=micro_feats(rows)
    if f is None:
        return '特征不足'
    prob_up=predict(f)  # 涨概率
    cur_price=rows[-1][1]
    ts=int(time.time()*1000)
    # 判定进行中的开仓(10分钟后)
    if state.get('open') and ts>=state['open']['openTs']+600000:
        t=state['open']
        win=(cur_price>t['base'] and t['side']=='LONG') or (cur_price<t['base'] and t['side']=='SHORT')
        w=t['wallet']
        u=state['users'].get(w,{'balance':100,'wins':0,'losses':0,'equity_curve':[100]})
        if win:
            u['balance']=round(u['balance']+TRADE_USDT*0.8,2);u['wins']+=1
        else:
            u['balance']=round(u['balance']-TRADE_USDT,2);u['losses']+=1
        u['equity_curve'].append(u['balance'])
        state['trades'].append({'wallet':w,'side':t['side'],'base':t['base'],'close':cur_price,'win':win,'ts':ts,'result':round(TRADE_USDT*0.8 if win else -TRADE_USDT,2)})
        state['open']=None
    # 高置信度开新仓
    if not state.get('open'):
        conf=abs(prob_up-0.5)
        if conf>=CONF_THRESHOLD:
            side='LONG' if prob_up>0.5 else 'SHORT'
            # 选一个资金够的用户
            for w,u in state['users'].items():
                if u['balance']>=MIN_USDT:
                    state['open']={'wallet':w,'side':side,'base':cur_price,'openTs':int(time.time()*1000)}
                    return f'开仓 {side} @{cur_price:.1f} 置信{conf:.2f}'
            return '无用户资金够'
    return f'预测涨{prob_up:.2f} 价{cur_price:.1f}'

def main():
    state=load_state()
    print(f"🚀 BTC 模拟盘引擎启动 | 用户{len(state['users'])} | 置信阈值{CONF_THRESHOLD}",flush=True)
    while True:
        try:
            msg=tick(state)
            save_state(state)
            print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}",flush=True)
        except Exception as e:
            print(f"[err] {e}",flush=True)
        time.sleep(55)

if __name__=='__main__':
    main()
