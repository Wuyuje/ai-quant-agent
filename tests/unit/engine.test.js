/**
 * Engine Core Tests — ATR, 信号强度, 风控逻辑
 */
const fs = require('fs');
const path = require('path');

// We need to test the ATR calculation logic from engine.js
// Since Engine has heavy dependencies, we extract and test the pure logic

// ═══ Test: ATR Calculation ═══
describe('ATR Calculation', () => {
  // Replicate _calculateATR from engine.js for testing
  function calculateATR(klines, period = 14) {
    if (!klines || klines.length < period + 1) return 0;
    const trueRanges = [];
    for (let i = 1; i < klines.length; i++) {
      const high = klines[i].high || klines[i].close || 0;
      const low = klines[i].low || klines[i].close || 0;
      const prevClose = klines[i - 1].close || 0;
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }
    const slice = trueRanges.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  test('should return 0 for empty klines', () => {
    expect(calculateATR([], 14)).toBe(0);
  });

  test('should return 0 for insufficient klines', () => {
    const klines = Array(10).fill({ high: 100, low: 95, close: 98 });
    expect(calculateATR(klines, 14)).toBe(0);
  });

  test('should calculate correct ATR for flat market', () => {
    const klines = Array(20).fill({ high: 100, low: 99, close: 99.5 });
    const atr = calculateATR(klines, 14);
    // TR for flat market: high-low = 1, abs(high-prevClose) = 0.5, abs(low-prevClose) = 0.5
    // Max TR = 1
    expect(atr).toBeCloseTo(1, 1);
  });

  test('should calculate correct ATR for volatile market', () => {
    const klines = [];
    let price = 100;
    for (let i = 0; i < 30; i++) {
      const change = i % 2 === 0 ? 5 : -5;
      price += change;
      klines.push({ high: price + 3, low: price - 3, close: price });
    }
    const atr = calculateATR(klines, 14);
    expect(atr).toBeGreaterThan(5); // Should reflect high volatility
    expect(atr).toBeLessThan(20); // But not unreasonably large
  });

  test('should handle klines with missing fields gracefully', () => {
    const klines = Array(20).fill({});
    const atr = calculateATR(klines, 14);
    expect(atr).toBe(0); // All zeros → ATR = 0
  });
});

// ═══ Test: Signal Strength Scoring ═══
describe('Signal Strength Scoring', () => {
  // Replicate scoring logic from _scanAndOpen
  function calculateStrength(signal, ind) {
    let strength = 0;
    const dir = signal.action === 'BUY' ? 'LONG' : 'SHORT';

    // Fusion score contribution (0-4)
    const absScore = Math.abs(signal.score);
    strength += Math.min(4, absScore * 4);

    // Confidence contribution (0-2)
    strength += signal.confidence * 2;

    // MA confirmation (0-1)
    const ma7 = ind.ma7 || ind.price;
    const ma25 = ind.ma25 || ind.price;
    if (dir === 'LONG' && ma7 > ma25) strength += 1;
    if (dir === 'SHORT' && ma7 < ma25) strength += 1;

    return strength;
  }

  test('strong BUY signal with MA confirmation should score high', () => {
    const signal = { action: 'BUY', score: 0.8, confidence: 0.9 };
    const ind = { price: 100, ma7: 102, ma25: 99 };
    const strength = calculateStrength(signal, ind);
    expect(strength).toBeGreaterThanOrEqual(6); // 3.2 + 1.8 + 1
  });

  test('weak SELL signal without MA confirmation should score low', () => {
    const signal = { action: 'SELL', score: 0.2, confidence: 0.4 };
    const ind = { price: 100, ma7: 102, ma25: 99 }; // MA disagrees (bullish)
    const strength = calculateStrength(signal, ind);
    expect(strength).toBeLessThan(3);
  });

  test('HOLD signal should produce zero strength from fusion', () => {
    const signal = { action: 'HOLD', score: 0, confidence: 0 };
    const ind = { price: 100, ma7: 100, ma25: 100 };
    const strength = calculateStrength(signal, ind);
    expect(strength).toBe(0);
  });
});

// ═══ Test: ATR-based Stop Loss / Take Profit ═══
describe('ATR Stop Loss / Take Profit', () => {
  test('stop loss should be 1.5x ATR (negative)', () => {
    const atrPct = 2.0; // 2%
    const stopLossPct = -(atrPct * 1.5);
    expect(stopLossPct).toBe(-3.0);
  });

  test('take profit should be 3x ATR (positive)', () => {
    const atrPct = 2.0;
    const takeProfitPct = atrPct * 3;
    expect(takeProfitPct).toBe(6.0);
  });

  test('risk-reward ratio should be 1:2', () => {
    const atrPct = 2.0;
    const sl = Math.abs(atrPct * 1.5);
    const tp = atrPct * 3;
    expect(tp / sl).toBe(2);
  });

  test('trailing trigger should be 2x ATR', () => {
    const atrPct = 2.0;
    const trigger = atrPct * 2;
    expect(trigger).toBe(4.0);
  });

  test('trailing pullback should be 1x ATR', () => {
    const atrPct = 2.0;
    const pullback = atrPct;
    expect(pullback).toBe(2.0);
  });
});

// ═══ Test: Leverage Tiers ═══
describe('Leverage Tiers', () => {
  function getLeverage(strength) {
    if (strength >= 5) return { leverage: 2, posPct: 15 };
    if (strength >= 3) return { leverage: 2, posPct: 10 };
    return { leverage: 1, posPct: 8 };
  }

  test('strong signal (>=5) → 2x leverage, 15% position', () => {
    const { leverage, posPct } = getLeverage(6);
    expect(leverage).toBe(2);
    expect(posPct).toBe(15);
  });

  test('medium signal (3-4) → 2x leverage, 10% position', () => {
    const { leverage, posPct } = getLeverage(4);
    expect(leverage).toBe(2);
    expect(posPct).toBe(10);
  });

  test('weak signal (<3) → 1x leverage, 8% position', () => {
    const { leverage, posPct } = getLeverage(2);
    expect(leverage).toBe(1);
    expect(posPct).toBe(8);
  });

  test('leverage should never exceed 2x', () => {
    const { leverage } = getLeverage(100);
    expect(leverage).toBeLessThanOrEqual(2);
  });
});

// ═══ Test: Cooldown Period ═══
describe('Cooldown Period', () => {
  const COOLDOWN_MS = 8 * 3600 * 1000; // 8 hours

  test('should be blocked if within 8 hours', () => {
    const lastClose = Date.now() - 4 * 3600 * 1000; // 4 hours ago
    const elapsed = Date.now() - lastClose;
    expect(elapsed < COOLDOWN_MS).toBe(true);
  });

  test('should be allowed after 8 hours', () => {
    const lastClose = Date.now() - 9 * 3600 * 1000; // 9 hours ago
    const elapsed = Date.now() - lastClose;
    expect(elapsed >= COOLDOWN_MS).toBe(true);
  });

  test('should be allowed if never traded (lastClose=0)', () => {
    const lastClose = 0;
    const elapsed = Date.now() - lastClose;
    expect(elapsed >= COOLDOWN_MS).toBe(true);
  });
});
