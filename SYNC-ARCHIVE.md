# 项目同步档案（MasterD 维护）

> 最后更新：2026-10-24 16:07

## 一、Git 仓库

| 项目 | 值 |
|------|-----|
| 远程地址 | https://github.com/Wuyuje/ai-quant-agent.git |
| 分支 | main |
| Pod 本地仓库 | /tmp/ai-quant-agent |
| 云端服务器仓库 | /root/ark-tools |
| 最近推送 commit | b2eb59d（2026-10-18） |
| 本次新增 commit | 7d09803（ark-tools 完整同步，**未推送**） |

## 二、云端服务器

| 项目 | 值 |
|------|-----|
| IP | 65.20.68.166 |
| 用户 | root |
| 主程序目录 | /root/ark-tools |
| 服务端口 | 18080 |
| 启动命令 | cd /root/ark-tools && setsid nohup node server.mjs > ark-tools.log 2>&1 |
| 主程序文件 | server.mjs（后端）、app2.js（前端逻辑）、index.html（页面） |
| 数据目录 | /root/ark-tools/state（coef-alerts.json、users.json、tokens.json 等） |
| 备份目录 | /root/ark-tools/state/archive |

## 三、已修复问题清单

1. **_wa is not defined** → app2.js 中 `_wa` 改为 `window._wa` 导出
2. **coefChHint 暴力清空 SendKey** → 改为智能保留已有合法 SendKey
3. **回填顺序错误** → 先写 SendKey 再切通道，末尾兜底再写一次
4. **登录令牌过期** → 延长到 2027-10-24
5. **阈值唯一性** → 每用户只保留一条，新设定覆盖旧的（replaced:1）

## 四、阈值记录状态

云端 `/root/ark-tools/state/coef-alerts.json` 当前有 2 条记录：
- 0x2c8f48...68f7 → 0.42
- 0xa52eb0...9366 → 0.41

（用户要求清空历史阈值，此项待确认）

## 五、GitHub 推送凭据

**服务器和 Pod 均无 GitHub 推送凭据。**
- 无 .git-credentials
- 无 .netrc
- 无 SSH 私钥
- 无环境变量 token
- gh CLI 未安装

推送需要 GitHub Personal Access Token（勾选 repo 权限）。

## 六、GitHub 上缺失的内容

GitHub 停在 b2eb59d（10月18日），缺失：
- /root/ark-tools 全部 86 个变更
- ARK Citizen Tools v2 前端
- 阈值修复补丁
- 微信绑定修复补丁
