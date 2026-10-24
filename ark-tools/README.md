# ARK Citizen Tools · ARK 公民工具站

ARK 質押收益追蹤與鏈上數據工具站。

## 功能

- **複利計算器** — 單利/複利切換，5 種鎖倉方案，成長曲線
- **方案對比** — 360 / 540 / 720 天複利軌跡
- **燃燒費率表** — 5 檔解鎖週期
- **鏈上數據** — ARK 價格 / 市值 / FDV / 流動性 / 流通量（PancakeSwap V2 真實讀取）
- **ARK 底層邏輯引擎** — 六大模組（EM/RBS/YRF/RCM/POL/DAO）、恆定乘積做市、雙池聯動、RBS 價格區間、資金流轉路徑
- **ARKIE 子幣** — 雙層結構、三大定位、市場數據、兌換器、代幣分配、造血飛輪
- **多帳戶管理** — 本地儲存，收益曲線
- **提領成本建議** — 5 檔到手對比
- **地址監控** — BSC 地址與異動記錄
- **歷史走勢** — 7D/30D/全部 + CSV 匯出
- **推播通知** — Telegram / 微信

## 技術

- 前端：純 HTML/CSS/JS + Chart.js（無 build）
- 後端：Node.js（零 npm 依賴）
- 7 語言：繁中 / 簡中 / EN / 日本語 / 한국어 / ES / VI

## 鏈上參數（BSC）

| 項目 | 地址 |
|---|---|
| ARK 代幣 | `0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D` |
| ARK/USDT Pair | `0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8` |
| ARKIE 代幣 | `0x6cd3025F851F36e74937D4e652f6AE9D4b2E88cF` |
| ARKIE/ARK Pair | `0x41EceDC0C020153E4526cB8a3dDBc5a3F252b184` |
| gARK (治理) | `0x911f12D137D74E5917877f87cf8A8bB2FDde557f` |

## 部署

```bash
# Docker
bash deploy.sh

# 或 Node 直跑
PORT=18080 node server.mjs
```

## API

```
GET  /api/health      健康檢查
GET  /api/ark         ARK 完整市場數據
GET  /api/arkie       ARKIE 完整市場數據
GET  /api/chain       精簡鏈上數據
GET  /api/stats       交易數/持有者/運行天數
GET  /api/snapshots   歷史快照
POST /api/notify      通知發送
```

## 風險聲明

本工具僅提供數據計算與追蹤，不託管任何資產，不構成投資建議。
ARK 質押收益率依市場熱度及流動性變動，並非固定。
