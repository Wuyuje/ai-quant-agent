/**
 * UserTrader NaN Protection & Close Position Logic Tests
 */
// Test the close position logic without full module loading
// (which requires ethers, BSC RPC, etc.)

describe('UserTrader Close Position Logic', () => {
  // Replicate the critical PnL calculation logic from _checkClosePosition
  function calculatePnL(pos, currentPrice) {
    const entryPrice = pos.entryPrice;
    if (!entryPrice || !currentPrice || !isFinite(currentPrice) || !isFinite(entryPrice)) {
      return { rawPnlPct: 0, netPnlPct: -0.008, leveragedPnl: -0.016 }; // safe defaults
    }
    let rawPnlPct;
    if (pos.side === 'LONG') {
      rawPnlPct = (currentPrice - entryPrice) / entryPrice;
    } else {
      rawPnlPct = (entryPrice - currentPrice) / entryPrice;
    }
    const singleSideCost = (pos.costPct || 0.016) / 2;
    const netPnlPct = rawPnlPct - singleSideCost;
    const leveragedPnl = netPnlPct * (pos.leverage || 2);
    return { rawPnlPct, netPnlPct, leveragedPnl };
  }

  describe('NaN Protection', () => {
    test('should not produce NaN for valid LONG position', () => {
      const pos = { side: 'LONG', entryPrice: 100, leverage: 2, costPct: 0.016 };
      const { rawPnlPct, netPnlPct, leveragedPnl } = calculatePnL(pos, 105);
      expect(isNaN(rawPnlPct)).toBe(false);
      expect(isNaN(netPnlPct)).toBe(false);
      expect(isNaN(leveragedPnl)).toBe(false);
      expect(rawPnlPct).toBeCloseTo(0.05, 4);
    });

    test('should not produce NaN for SHORT position', () => {
      const pos = { side: 'SHORT', entryPrice: 100, leverage: 2, costPct: 0.016 };
      const { rawPnlPct } = calculatePnL(pos, 95);
      expect(isNaN(rawPnlPct)).toBe(false);
      expect(rawPnlPct).toBeCloseTo(0.05, 4);
    });

    test('should handle entryPrice = 0 without NaN', () => {
      const pos = { side: 'LONG', entryPrice: 0, leverage: 2 };
      const { rawPnlPct } = calculatePnL(pos, 100);
      expect(isNaN(rawPnlPct)).toBe(false);
      expect(rawPnlPct).toBe(0); // safe default
    });

    test('should handle currentPrice = 0 without NaN', () => {
      const pos = { side: 'LONG', entryPrice: 100, leverage: 2 };
      const { rawPnlPct } = calculatePnL(pos, 0);
      expect(isNaN(rawPnlPct)).toBe(false);
      expect(rawPnlPct).toBe(0); // safe default
    });

    test('should handle undefined prices without NaN', () => {
      const pos = { side: 'LONG', entryPrice: undefined, leverage: 2 };
      const { rawPnlPct } = calculatePnL(pos, undefined);
      expect(isNaN(rawPnlPct)).toBe(false);
    });

    test('should handle Infinity prices without NaN', () => {
      const pos = { side: 'LONG', entryPrice: Infinity, leverage: 2 };
      const { rawPnlPct } = calculatePnL(pos, 100);
      expect(isNaN(rawPnlPct)).toBe(false);
    });
  });

  describe('Cost-aware PnL', () => {
    test('should deduct single-side cost from PnL', () => {
      const pos = { side: 'LONG', entryPrice: 100, leverage: 1, costPct: 0.016 };
      const { netPnlPct } = calculatePnL(pos, 100);
      // rawPnl = 0, singleSideCost = 0.008
      expect(netPnlPct).toBeCloseTo(-0.008, 4); // slightly negative due to cost
    });

    test('should apply leverage to PnL', () => {
      const pos = { side: 'LONG', entryPrice: 100, leverage: 3, costPct: 0.016 };
      const { leveragedPnl } = calculatePnL(pos, 103);
      // rawPnl = 0.03, netPnl = 0.03 - 0.008 = 0.022, leveraged = 0.022 * 3 = 0.066
      expect(leveragedPnl).toBeCloseTo(0.066, 3);
    });
  });

  describe('Close Triggers', () => {
    test('extreme stop loss at -5% net PnL', () => {
      const pos = { side: 'LONG', entryPrice: 100, leverage: 1, costPct: 0.016 };
      const { netPnlPct } = calculatePnL(pos, 94.2); // -5.8% raw, ~-6.6% net
      expect(netPnlPct).toBeLessThanOrEqual(-0.05);
    });

    test('take profit at +5% net PnL', () => {
      const pos = { side: 'LONG', entryPrice: 100, leverage: 1, costPct: 0.016 };
      const { netPnlPct } = calculatePnL(pos, 106); // +6% raw, ~+5.2% net
      expect(netPnlPct).toBeGreaterThanOrEqual(0.05);
    });

    test('trailing stop: peak 4%+, pullback to 60% of peak', () => {
      const peakPnl = 0.05; // 5% peak
      const triggerThreshold = 0.04;
      const pullbackLine = peakPnl * 0.6; // 3%
      expect(peakPnl).toBeGreaterThanOrEqual(triggerThreshold);
      expect(pullbackLine).toBe(0.03);
    });
  });
});

describe('UserTrader Stats Tracking (Kelly Input)', () => {
  // Replicate _updateUserStats logic
  function updateUserStats(stats, netPnlPct, pnlUsd) {
    if (!stats) stats = { wins: 0, losses: 0, totalPnl: 0, avgWin: 0, avgLoss: 0, winRate: 0 };
    
    stats.totalPnl = (stats.totalPnl || 0) + (pnlUsd || 0);
    
    if (!isFinite(netPnlPct)) netPnlPct = 0;
    
    if (netPnlPct > 0) {
      stats.wins = (stats.wins || 0) + 1;
      stats.avgWin = stats.avgWin > 0 
        ? stats.avgWin * 0.7 + netPnlPct * 0.3 
        : netPnlPct;
    } else {
      stats.losses = (stats.losses || 0) + 1;
      const absPnl = Math.abs(netPnlPct);
      stats.avgLoss = stats.avgLoss > 0 
        ? stats.avgLoss * 0.7 + absPnl * 0.3 
        : Math.max(absPnl, 0.01); // floor at 0.01 to prevent /0
    }
    
    const total = stats.wins + stats.losses;
    stats.winRate = total > 0 ? stats.wins / total : 0;
    
    return stats;
  }

  test('should track wins correctly', () => {
    let stats = null;
    stats = updateUserStats(stats, 0.03, 30);
    stats = updateUserStats(stats, 0.05, 50);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(0);
    expect(stats.winRate).toBe(1);
  });

  test('should track losses correctly', () => {
    let stats = null;
    stats = updateUserStats(stats, -0.02, -20);
    stats = updateUserStats(stats, -0.01, -10);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(2);
    expect(stats.winRate).toBe(0);
  });

  test('should handle zero PnL without corrupting avgLoss', () => {
    let stats = null;
    stats = updateUserStats(stats, 0, 0); // breakeven
    expect(stats.avgLoss).toBeGreaterThan(0); // should be floored at 0.01
    expect(isNaN(stats.avgWin)).toBe(false);
    expect(isNaN(stats.avgLoss)).toBe(false);
  });

  test('should handle NaN PnL without propagating', () => {
    let stats = null;
    stats = updateUserStats(stats, NaN, NaN);
    expect(isNaN(stats.avgWin)).toBe(false);
    expect(isNaN(stats.avgLoss)).toBe(false);
    expect(isNaN(stats.winRate)).toBe(false);
  });

  test('should calculate mixed win/loss correctly', () => {
    let stats = null;
    stats = updateUserStats(stats, 0.04, 40);
    stats = updateUserStats(stats, -0.02, -20);
    stats = updateUserStats(stats, 0.06, 60);
    stats = updateUserStats(stats, -0.01, -10);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(2);
    expect(stats.winRate).toBe(0.5);
    expect(stats.avgWin).toBeGreaterThan(0);
    expect(stats.avgLoss).toBeGreaterThan(0);
  });
});
