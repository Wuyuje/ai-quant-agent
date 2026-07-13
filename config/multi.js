/**
 * MultiEngine 配置
 * 
 * 与 default.json 共享 Binance/交易配置
 * 独有配置项在此定义
 */

const DEFAULT_CONFIG = require('./default.json');

module.exports = {
  // 复用默认配置
  ...DEFAULT_CONFIG,

  // MultiEngine 特有配置
  multi: {
    apiPort: 8010,
    maxUsers: 50,               // 最大用户数
    userStartDelay: 2000,       // 用户启动间隔 (ms)
    statsIntervalMs: 5000,      // 统计刷新间隔
    evolutionIntervalMs: 300000, // 聚合进化间隔 (5分钟)
    
    // 收益分配
    revenue: {
      platformFeePct: 20,       // 平台提成 20%
      userSharePct: 70,         // 用户收益 70%
      ecoFundPct: 10,           // 生态基金 10%
      monthlyFeeUsd: 29.9,      // 月费
    },
    
    // 订阅等级
    subscriptions: {
      free: { maxPositions: 1, leverageLimit: 3, symbols: ['BTCUSDT'] },
      basic: { maxPositions: 3, leverageLimit: 5, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] },
      pro: { maxPositions: 5, leverageLimit: 10, symbols: 'all' },
    },
  },
};
