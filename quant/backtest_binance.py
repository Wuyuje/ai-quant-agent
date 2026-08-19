#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
# 📊 EMA vs V4 对比回测 (币安15m 数据)
# 用币安实际交易数据回测, 保持与实盘一致
# EMA: EMA7/25/99 排列+突破/回踩
# V4: 趋势结构+关键位+量能
# ═══════════════════════════════════════════════════════════
import urllib.request, json, time

UA={'User-Agent':'Mozilla/5.0'}
BINANCE='https://api.binance.com/api/v3/klines'
SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','UNIUSDT','LTCUSDT']
swingLen=3

def get_klines(sym, interval='1h', limit=1000):
    """拉币安K线(分页拉更多)"""
    data=[]
    try:
        # 拉3段×1000根≈更长时间
        endTime=''
        for _ in range(3):
            url=f'{BINANCE}?symbol={sym}&interval={interval}&limit=1000'
            if endTime: url+=f'&endTime={endTime}'
            req=urllib.request.Request(url,headers=UA)
            batch=json.loads(urllib.request.urlopen(req,timeout=12).read().decode())
            if not batch: break
            data=batch+data
            endTime=str(batch[0][0])
            time.sleep(0.2)
    except Exception as e:
        return []
    return [{'date':x[0],'open':float(x[1]),'high':float(x[2]),'low':float(x[3]),'close':float(x[4]),'vol':float(x[5])} for x in data]

def ema(c,p):
    if len(c)<p: return None
    k=2/(p+1); e=c[-p]
    for i in range(len(c)-p+1,len(c)): e=c[i]*k+e*(1-k)
    return e

def bt_ema(s):
    c=[s['close'] for s in s]
    pos=None;t=w=0;ret=0
    for i in range(160,len(s)-1):
        cls=c[:i+1]; e7=ema(cls,7); e25=ema(cls,25); e99=ema(cls,99)
        price=c[i]; hi30=max(c[i-30:i]); lo30=min(c[i-30:i])
        if pos:
            if pos=='LONG':
                if (e7 and e25 and e7<e25 and price<e25) or (e99 and price<e99):
                    r=(price-pos_entry)/pos_entry;ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
            else:
                if (e7 and e25 and e7>e25 and price>e25) or (e99 and price>e99):
                    r=(pos_entry-price)/pos_entry;ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
        else:
            if e7 and e25 and e99:
                if e7>e25>e99 and (price>hi30 or (e25 and price>=e25*0.998)): pos='LONG';pos_entry=price
                elif e7<e25<e99 and (price<lo30 or (e25 and price<=e25*1.002)): pos='SHORT';pos_entry=price
    return {'t':t,'wr':round(w/t*100,1) if t else 0,'avg':round(ret/t*100,2) if t else 0,'total':round(ret*100,1)}

def v4_dir(c,i):
    lw=[];hw=[]
    for j in range(swingLen,i-swingLen):
        win=c[j-swingLen:j+swingLen+1]
        if c[j]==min(win): lw.append((j,c[j]))
        if c[j]==max(win): hw.append((j,c[j]))
    if len(lw)>=3 and lw[-2][1]>lw[-3][1] and lw[-1][1]>lw[-2][1]: return 'UP',lw[-1][1],(hw[-1][1] if hw else 0)
    if len(hw)>=3 and hw[-2][1]<hw[-3][1] and hw[-1][1]<hw[-2][1]: return 'DOWN',hw[-1][1],(lw[-1][1] if lw else 0)
    return 'FLAT',0,0

def bt_v4(s):
    c=[s['close'] for s in s];pos=None;t=w=0;ret=0
    for i in range(60,len(s)-1):
        price=c[i]
        if pos:
            if pos=='LONG' and price<c[i-1] and c[i-1]<c[i-2]:
                r=(price-pos_entry)/pos_entry;ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
            elif pos=='SHORT' and price>c[i-1] and c[i-1]>c[i-2]:
                r=(pos_entry-price)/pos_entry;ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
        else:
            dir_,sup,res=v4_dir(c,i)
            if dir_=='FLAT': continue
            v_ratio=s[i]['vol']/(sum(x['vol'] for x in s[i-20:i])/20) if i>20 else 1
            if dir_=='UP' and res>0 and price>res>c[i-1] and v_ratio>1.3: pos='LONG';pos_entry=price
            elif dir_=='UP' and sup>0 and price>=sup*0.998 and v_ratio>1.3: pos='LONG';pos_entry=price
            elif dir_=='DOWN' and sup>0 and price<sup<c[i-1] and v_ratio>1.3: pos='SHORT';pos_entry=price
            elif dir_=='DOWN' and res>0 and price<=res*1.002 and v_ratio>1.3: pos='SHORT';pos_entry=price
    return {'t':t,'wr':round(w/t*100,1) if t else 0,'avg':round(ret/t*100,2) if t else 0,'total':round(ret*100,1)}

def main():
    print("EMA vs V4 回测 (币安1h)...")
    se={'t':0,'w':0,'r':0};sv={'t':0,'w':0,'r':0}
    for sym in SYMBOLS:
        s=get_klines(sym)
        if not s: print(sym,'无数据');continue
        em=bt_ema(s); v4=bt_v4(s)
        se['t']+=em['t'];se['w']+=em['t']*em['wr']/100;se['r']+=em['avg'] if em['t'] else 0
        sv['t']+=v4['t'];sv['w']+=v4['t']*v4['wr']/100;sv['r']+=v4['avg'] if v4['t'] else 0
        print(f"{sym}: EMA[t{em['t']} w{em['wr']}% a{em['avg']}%] vs V4[t{v4['t']} w{v4['wr']}% a{v4['avg']}%]")
        time.sleep(0.3)
    print(f"\n═══ 对比(币安) ═══")
    print(f"EMA: 总{se['t']}笔 胜率{round(se['w']/se['t']*100,1)}% 均单{round(se['r']/se['t'],2)}%")
    print(f"V4 : 总{sv['t']}笔 胜率{round(sv['w']/sv['t']*100,1)}% 均单{round(sv['r']/sv['t'],2)}%")

if __name__=='__main__': main()
