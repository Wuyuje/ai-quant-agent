/**
 * RiskIsolator v3 — 风控熔断器
 * 
 * 核心设计原则：
 *   1. 用户间完全隔离 — 一个用户爆仓不影响其他人
 *   2. 分层熔断 — 个人 → 群组 → 全局
 *   3. 自动恢复 — 降级后条件满足自动恢复
 *   4. 管理员干预 — 任何时候管理员可全局紧急停止
 * 
 * 风控参数：
 *   - 单用户最大回撤：20% → 警告，25% → 熔断
 *   - 群组熔断：>10% 用户触发个人熔断 → 暂停群组
 *   - 全局熔断：>20% 用户触发 → 暂停全部交易
 *   - 重新启用：回撤恢复到 <15% 后自动恢复
 */

const EventEmitter = require('events');

// ═══ 风控等级 ═══
const RISK_LEVEL = {
  SAFE: 'safe',           // 安全：正常交易
  WARNING: 'warning',     // 警告：接近限制
  RESTRICTED: 'restricted', // 受限：禁止新开仓
  HALTED: 'halted',       // 熔断：强制平仓
  EMERGENCY: 'emergency', // 紧急停止：管理员触发
};

// ═══ 配置 ═══
const DEFAULT_CONFIG = {
  // 单用户风控
  maxDrawdownWarning: 0.20,      // 20% 回撤 → 警告
  maxDrawdownHalt: 0.25,         // 25% 回撤 → 熔断
  maxPositionPct: 0.30,          // 单仓位不超过总资产30%
  maxLeverage: 3,                // 最大杠杆
  recoveryThreshold: 0.15,       // 回撤恢复到15%以下 → 重新启用

  // 群组风控
  groupHaltThreshold: 0.10,      // 10%用户熔断 → 暂停群组
  
  // 全局风控
  globalHaltThreshold: 0.20,     // 20%用户熔断 → 暂停全部
  
  // 检查间隔
  checkInterval: 30000,          // 30秒检查一次
  cooldownAfterHalt: 900000,     // v113.15: 熔断后冷却15分钟(之前1小时太长)
};

class RiskIsolator extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = (msg) => console.log(`[RiskIsolator] ${new Date().toISOString()} ${msg}`);

    // 用户风控状态
    this.userRisk = {};  // userId → { level, drawdown, peakPnl, lastCheck, haltedAt }

    // 全局状态
    this.globalLevel = RISK_LEVEL.SAFE;
    this.emergencyStop = false;
    this.globalHaltedAt = null;

    // 统计
    this.stats = {
      totalChecks: 0,
      warnings: 0,
      halts: 0,
      recoveries: 0,
      emergencyStops: 0,
    };

    // 定期检查
    this._checkInterval = null;
  }

  // ═══ 初始化 ═══
  start() {
    this._checkInterval = setInterval(() => this._periodicCheck(), this.config.checkInterval);
    this.log(`风控系统启动 — 检查间隔 ${this.config.checkInterval / 1000}s`);
  }

  stop() {
    if (this._checkInterval) clearInterval(this._checkInterval);
    this.log('风控系统已停止');
  }

  // ═══ 用户注册 ═══
  registerUser(userId, initialPnl = 0) {
    this.userRisk[userId] = {
      level: RISK_LEVEL.SAFE,
      drawdown: 0,
      peakPnl: initialPnl,
      peakBalance: initialPnl,  // v113.15: 余额峰值用于回撤计算
      currentPnl: initialPnl,
      initialBalance: initialPnl || 1,
      lastCheck: Date.now(),
      haltedAt: null,
      warningCount: 0,
      restrictionCount: 0,
      haltCount: 0,
    };
  }

  unregisterUser(userId) {
    delete this.userRisk[userId];
  }

  // ═══ 核心：更新用户盈亏并评估风险 ═══
  /**
   * @param {string} userId
   * @param {number} currentPnl - 当前净利润（正=盈利，负=亏损）
   * @param {number} totalBalance - 用户总资产
   * @returns {{ level: string, allowed: boolean, reason: string }}
   */
  updateAndCheck(userId, currentPnl, totalBalance) {
    this.stats.totalChecks++;

    if (!this.userRisk[userId]) {
      this.registerUser(userId, totalBalance);
    }

    const risk = this.userRisk[userId];
    risk.currentPnl = currentPnl;
    risk.lastCheck = Date.now();
    // v113.15: 保留总余额用于回撤计算
    risk.totalBalance = totalBalance;

    // ═══ 紧急停止 ═══
    if (this.emergencyStop) {
      risk.level = RISK_LEVEL.EMERGENCY;
      return { level: RISK_LEVEL.EMERGENCY, allowed: false, reason: '全局紧急停止已触发' };
    }

    // ═══ v113.15: 修复回撤计算 — 用余额峰值计算，不再用pnl峰值 ═══
    // 之前: peakPnl初始化为totalBalance(~$47), currentPnl是累计盈亏(从0开始)
    // 两者不匹配导致drawdown=146%直接熔断
    // 现在: 用总余额的峰值回撤，符合实际风控逻辑
    if (totalBalance > risk.peakBalance) {
      risk.peakBalance = totalBalance;
    }
    risk.drawdown = risk.peakBalance > 0
      ? Math.max(0, (risk.peakBalance - totalBalance) / risk.peakBalance)
      : 0;

    // ═══ 评估等级 ═══
    let newLevel = RISK_LEVEL.SAFE;
    let allowed = true;
    let reason = '';

    // 已熔断 → 检查恢复条件
    if (risk.level === RISK_LEVEL.HALTED || risk.level === RISK_LEVEL.EMERGENCY) {
      if (risk.drawdown < this.config.recoveryThreshold) {
        // 冷却期检查
        const cooldownMs = Date.now() - (risk.haltedAt || 0);
        if (cooldownMs > this.config.cooldownAfterHalt) {
          newLevel = RISK_LEVEL.SAFE;
          reason = `回撤恢复至 ${(risk.drawdown * 100).toFixed(1)}%，冷却期已过，重新启用`;
          this.stats.recoveries++;
          this.emit('user:recover', userId);
        } else {
          newLevel = RISK_LEVEL.HALTED;
          const remaining = Math.ceil((this.config.cooldownAfterHalt - cooldownMs) / 60000);
          reason = `冷却中，剩余 ${remaining} 分钟`;
        }
      } else {
        newLevel = RISK_LEVEL.HALTED;
        reason = `回撤 ${(risk.drawdown * 100).toFixed(1)}% 仍高于恢复阈值 ${(this.config.recoveryThreshold * 100)}%`;
      }
    }
    // 正常流程
    else if (risk.drawdown >= this.config.maxDrawdownHalt) {
      newLevel = RISK_LEVEL.HALTED;
      allowed = false;
      reason = `回撤 ${(risk.drawdown * 100).toFixed(1)}% >= 熔断阈值 ${(this.config.maxDrawdownHalt * 100)}%`;
      risk.haltedAt = Date.now();
      this.stats.halts++;
      this.emit('user:halt', userId, risk);
    }
    else if (risk.drawdown >= this.config.maxDrawdownWarning) {
      newLevel = RISK_LEVEL.WARNING;
      reason = `回撤 ${(risk.drawdown * 100).toFixed(1)}% >= 警告阈值 ${(this.config.maxDrawdownWarning * 100)}%`;
      risk.warningCount++;
      this.stats.warnings++;
      this.emit('user:warning', userId, risk);
    }
    else if (risk.drawdown >= this.config.maxDrawdownWarning * 0.7) {
      newLevel = RISK_LEVEL.SAFE;
      reason = `回撤 ${(risk.drawdown * 100).toFixed(1)}% 接近警告线`;
    }
    else {
      newLevel = RISK_LEVEL.SAFE;
      reason = `回撤 ${(risk.drawdown * 100).toFixed(1)}% 正常`;
    }

    risk.level = newLevel;

    // ═══ 群组/全局评估 ═══
    this._evaluateGlobal();

    return { level: newLevel, allowed, reason };
  }

  /**
   * 检查是否允许开新仓
   */
  canOpenPosition(userId, positionValue, totalBalance) {
    if (this.emergencyStop) return { allowed: false, reason: '全局紧急停止' };

    const risk = this.userRisk[userId];
    if (!risk) return { allowed: true, reason: '新用户' };

    if (risk.level === RISK_LEVEL.HALTED || risk.level === RISK_LEVEL.EMERGENCY) {
      return { allowed: false, reason: `用户 ${risk.level}` };
    }

    if (risk.level === RISK_LEVEL.WARNING) {
      return { allowed: false, reason: '警告状态，禁止开新仓' };
    }

    // 仓位大小检查
    if (totalBalance > 0 && positionValue / totalBalance > this.config.maxPositionPct) {
      return {
        allowed: false,
        reason: `仓位 ${(positionValue / totalBalance * 100).toFixed(1)}% > 最大 ${(this.config.maxPositionPct * 100)}%`,
      };
    }

    return { allowed: true, reason: '通过' };
  }

  /**
   * 全局评估
   */
  _evaluateGlobal() {
    const users = Object.values(this.userRisk);
    if (users.length === 0) return;

    const haltedCount = users.filter(u => u.level === RISK_LEVEL.HALTED || u.level === RISK_LEVEL.EMERGENCY).length;
    const warningCount = users.filter(u => u.level === RISK_LEVEL.WARNING).length;
    const ratio = haltedCount / users.length;

    if (ratio >= this.config.globalHaltThreshold && this.globalLevel !== RISK_LEVEL.HALTED) {
      this.globalLevel = RISK_LEVEL.HALTED;
      this.log(`⚠️ 全局熔断触发！${haltedCount}/${users.length} 用户 (${(ratio * 100).toFixed(1)}%) 已熔断`);
      this.emit('global:halt', { haltedCount, total: users.length, ratio });
    } else if (ratio >= this.config.groupHaltThreshold && this.globalLevel === RISK_LEVEL.SAFE) {
      this.globalLevel = RISK_LEVEL.WARNING;
      this.log(`⚠️ 群组警告：${haltedCount}/${users.length} 用户已熔断`);
      this.emit('global:warning', { haltedCount, total: users.length });
    } else if (ratio < this.config.groupHaltThreshold * 0.5 && this.globalLevel !== RISK_LEVEL.SAFE) {
      this.globalLevel = RISK_LEVEL.SAFE;
      this.log(`✅ 全局恢复正常`);
      this.emit('global:recover');
    }
  }

  /**
   * 管理员紧急停止
   */
  emergencyStopAll(reason = '管理员手动触发') {
    this.emergencyStop = true;
    this.globalLevel = RISK_LEVEL.EMERGENCY;
    this.stats.emergencyStops++;
    this.log(`🚨 紧急停止！原因: ${reason}`);
    this.emit('global:emergency', { reason });

    // 所有用户设为紧急停止
    Object.keys(this.userRisk).forEach(userId => {
      this.userRisk[userId].level = RISK_LEVEL.EMERGENCY;
    });
  }

  /**
   * 解除紧急停止
   */
  resumeFromEmergency() {
    this.emergencyStop = false;
    this.globalLevel = RISK_LEVEL.SAFE;
    Object.keys(this.userRisk).forEach(userId => {
      if (this.userRisk[userId].level === RISK_LEVEL.EMERGENCY) {
        this.userRisk[userId].level = RISK_LEVEL.SAFE;
      }
    });
    this.log('✅ 紧急停止已解除');
    this.emit('global:resume');
  }

  /**
   * 定期检查
   */
  _periodicCheck() {
    const now = Date.now();
    Object.entries(this.userRisk).forEach(([userId, risk]) => {
      if (now - risk.lastCheck > this.config.checkInterval * 3) {
        // 超过3个周期没更新 → 可能掉线
        this.emit('user:stale', userId, risk);
      }
    });
  }

  /**
   * 获取风控概览
   */
  getOverview() {
    const users = Object.values(this.userRisk);
    return {
      globalLevel: this.globalLevel,
      emergencyStop: this.emergencyStop,
      totalUsers: users.length,
      byLevel: {
        safe: users.filter(u => u.level === RISK_LEVEL.SAFE).length,
        warning: users.filter(u => u.level === RISK_LEVEL.WARNING).length,
        halted: users.filter(u => u.level === RISK_LEVEL.HALTED).length,
        emergency: users.filter(u => u.level === RISK_LEVEL.EMERGENCY).length,
      },
      stats: this.stats,
    };
  }

  /**
   * 获取用户风控状态
   */
  getUserRisk(userId) {
    return this.userRisk[userId] || null;
  }
}

module.exports = { RiskIsolator, RISK_LEVEL };
