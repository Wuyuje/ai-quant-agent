#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
# 📊 EMA趋势策略 vs V4 对比回测 (15m级别)
# EMA: 均线排列(EMA7/25/99)+突破/回踩, 出场=均线反转/破位
# V4: 趋势结构(抬高低点)+关键位+量能
# ═══════════════════════════════════════════════════════════
import urllib.request, json, time

UA={'User-Agent':'Mozilla/5.0'}
K_URL='https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={0},m15,,320'
SYMBOLS=['sz002428','sh601869','sh603061','sh603129','sh603444','sh603986','sz002584','sh600519','sh601318','sh600036',
         'sz300059','sz002475','sh600536','sz002371','sz002916','sz000858','sz000001']
swingLen=3; confirmLows=2

def get_kline(sym):
    try:
        req=urllib.request.Request(K_URL.format(sym),headers=UA)
        d=json.loads(urllib.request.urlopen(req,timeout=15).read().decode())
        k=d['data'][sym].get('m15',[])
        return [{'date':x[0],'open':float(x[1]),'close':float(x[2]),'high':float(x[3]),'low':float(x[4]),'vol':float(x[5])} for x in k]
    except: return []

def ema(c,p):
    if len(c)<p: return None
    k=2/(p+1); e=c[-p]
    for i in range(len(c)-p+1,len(c)): e=c[i]*k+e*(1-k)
    return e

# ─── EMA策略(EMA7/25/99) ───
def bt_ema(stocks):
    c=[s['close'] for s in stocks]
    pos=None; t=w=0; ret=0
    for i in range(120,len(stocks)-1):
        cls=c[:i+1]
        e7=ema(cls,7); e25=ema(cls,25); e99=ema(cls,99)
        if pos:
            price=c[i]
            if pos=='LONG':
                # 止盈: EMA7跌破EMA25 或 止损: 跌破EMA99
                if e7 and e25 and e7<e25 and price<e25:
                    r=(price-pos_entry)/pos_entry; ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
                elif e99 and price<e99:
                    r=(price-pos_entry)/pos_entry; ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
            else:
                if e7 and e25 and e7>e25 and price>e25:
                    r=(pos_entry-price)/pos_entry; ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
                elif e99 and price>e99:
                    r=(pos_entry-price)/pos_entry; ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
        else:
            dir_='FLAT'
            if e7 and e25 and e99:
                if e7>e25>e99: dir_='UP'
                elif e7<e25<e99: dir_='DOWN'
            price=c[i]; prev=c[i-1]
            hi30=max(c[i-30:i]); lo30=min(c[i-30:i])
            if dir_=='UP' and price>hi30: pos='LONG'; pos_entry=price
            elif dir_=='UP' and e25 and price>=e25*0.998: pos='LONG'; pos_entry=price
            elif dir_=='DOWN' and price<lo30: pos='SHORT'; pos_entry=price
            elif dir_=='DOWN' and e25 and price<=e25*1.002: pos='SHORT'; pos_entry=price
    return {'t':t,'wr':round(w/t*100,1) if t else 0,'avg':round(ret/t*100,2) if t else 0,'total':round(ret*100,1)}

# ─── V4策略 ───
def v4_dir(closes,i):
    lws=[];hws=[]
    for j in range(swingLen,i-swingLen):
        win=closes[j-swingLen:j+swingLen+1]
        if closes[j]==min(win): lws.append((j,closes[j]))
        if closes[j]==max(win): hws.append((j,closes[j]))
    if len(lws)>=3 and lws[-2][1]>lws[-3][1] and lws[-1][1]>lws[-2][1]: return 'UP',lws[-1][1],(hws[-1][1] if hws else 0)
    if len(hws)>=3 and hws[-2][1]<hws[-3][1] and hws[-1][1]<hws[-2][1]: return 'DOWN',hws[-1][1],(lws[-1][1] if lws else 0)
    return 'FLAT',0,0
def bt_v4(stocks):
    c=[s['close'] for s in stocks]; pos=None;t=w=0;ret=0
    for i in range(50,len(stocks)-1):
        if pos:
            price=c[i]
            if pos=='LONG' and price<c[i-1] and c[i-1]<c[i-2]:
                r=(price-pos_entry)/pos_entry;ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
            elif pos=='SHORT' and price>c[i-1] and c[i-1]>c[i-2]:
                r=(pos_entry-price)/pos_entry;ret+=r;t+=1;w+=1 if r>0 else 0;pos=None
        else:
            dir_,sup,res=v4_dir(c,i)
            if dir_=='FLAT': continue
            price=c[i];prev=c[i-1]
            v_ratio=stocks[i]['vol']/(sum(s['vol'] for s in stocks[i-20:i])/20) if i>20 else 1
            if dir_=='UP' and res>0 and price>res and prev<=res and v_ratio>1.3: pos='LONG';pos_entry=price
            elif dir_=='UP' and sup>0 and price>=sup*0.998 and v_ratio>1.3: pos='LONG';pos_entry=price
            elif dir_=='DOWN' and sup>0 and price<sup and prev>=sup and v_ratio>1.3: pos='SHORT';pos_entry=price
            elif dir_=='DOWN' and res>0 and price<=res*1.002 and v_ratio>1.3: pos='SHORT';pos_entry=price
    return {'t':t,'wr':round(w/t*100,1) if t else 0,'avg':round(ret/t*100,2) if t else 0,'total':round(ret*100,1)}

def main():
    print("EMA vs V4 15m对比回测...")
    se={'t':0,'w':0,'r':0}; sv={'t':0,'w':0,'r':0}
    for sym in SYMBOLS:
        s=get_kline(sym)
        if not s: continue
        em=bt_ema(s); v4=bt_v4(s)
        se['t']+=em['t'];se['w']+=em['t']*em['wr']/100;se['r']+=em['avg'] if em['t'] else 0
        sv['t']+=v4['t'];sv['w']+=v4['t']*v4['wr']/100;sv['r']+=v4['avg'] if v4['t'] else 0
        print(f"{sym}: EMA[t{em['t']} w{em['wr']}% a{em['avg']}%] vs V4[t{v4['t']} w{v4['wr']}% a{v4['avg']}%]")
        time.sleep(0.3)
    print(f"\n═══ 对比 ═══")
    print(f"EMA: 总{se['t']}笔 胜率{round(se['w']/se['t']*100,1)}% 均单{round(se['r']/se['t'],2)}%")
    print(f"V4 : 总{sv['t']}笔 胜率{round(sv['w']/sv['t']*100,1)}% 均单{round(sv['r']/sv['t'],2)}%")

if __name__=='__main__': main()
