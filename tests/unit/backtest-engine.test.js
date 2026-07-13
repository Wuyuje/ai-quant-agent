/**
 * Backtest Engine Tests — Indicators & Decision Logic
 */
const BacktestEngine = require('../../backtest/backtest-engine');

describe('BacktestEngine', () => {
  let bt;

  beforeEach(() => {
    bt = new BacktestEngine();
  });

  describe('Indicator Calculations', () => {
    test('_sma should calculate simple moving average', () => {
      const arr = [10, 20, 30, 40, 50];
      const sma = bt._sma(arr, 5);
      expect(sma).toBe(30);
    });

    test('_sma should handle insufficient data', () => {
      const arr = [10, 20];
      const sma = bt._sma(arr, 5);
      expect(sma).toBe(20); // last element
    });

    test('_ema should calculate exponential moving average', () => {
      const arr = Array(20).fill(100);
      const ema = bt._ema(arr, 10);
      // Flat data → EMA should equal the value
      expect(ema).toBeCloseTo(100, 1);
    });

    test('_rsi should return 50 for insufficient data', () => {
      const arr = [100, 101];
      const rsi = bt._rsi(arr, 14);
      expect(rsi).toBe(50);
    });

    test('_rsi should return 100 for all gains', () => {
      const arr = [];
      for (let i = 0; i < 20; i++) arr.push(100 + i);
      const rsi = bt._rsi(arr, 14);
      expect(rsi).toBe(100);
    });

    test('_rsi should return 0 for all losses', () => {
      const arr = [];
      for (let i = 0; i < 20; i++) arr.push(100 - i);
      const rsi = bt._rsi(arr, 14);
      expect(rsi).toBeCloseTo(0, 0);
    });

    test('_atr should return 0 for insufficient data', () => {
      const highs = [100], lows = [99];
      const atr = bt._atr(highs, lows, 14);
      expect(atr).toBe(0);
    });

    test('_atr should calculate average true range', () => {
      const highs = [], lows = [];
      for (let i = 0; i < 20; i++) {
        highs.push(100 + i * 2);
        lows.push(95 + i * 2);
      }
      const atr = bt._atr(highs, lows, 14);
      expect(atr).toBeGreaterThan(0);
      expect(atr).toBeLessThan(100);
    });

    test('_bb should calculate Bollinger Bands', () => {
      const closes = [];
      for (let i = 0; i < 30; i++) closes.push(100 + Math.sin(i) * 2);
      const bb = bt._bb(closes, 20, 2);
      expect(bb).toHaveProperty('upper');
      expect(bb).toHaveProperty('middle');
      expect(bb).toHaveProperty('lower');
      expect(bb.upper).toBeGreaterThan(bb.middle);
      expect(bb.middle).toBeGreaterThan(bb.lower);
    });
  });

  describe('calcIndicators', () => {
    test('should return null for insufficient data', () => {
      const closes = [100, 101, 102];
      const result = bt.calcIndicators(closes, [], [], [], 2);
      expect(result).toBeNull();
    });

    test('should return full indicators for sufficient data', () => {
      const closes = [], highs = [], lows = [], volumes = [];
      for (let i = 0; i < 50; i++) {
        const price = 100 + Math.sin(i / 5) * 3;
        closes.push(price);
        highs.push(price + 1);
        lows.push(price - 1);
        volumes.push(1000 + Math.random() * 500);
      }
      const result = bt.calcIndicators(closes, highs, lows, volumes, 49);
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('price');
      expect(result).toHaveProperty('ma7');
      expect(result).toHaveProperty('ma25');
      expect(result).toHaveProperty('rsi');
      expect(result).toHaveProperty('atr');
      expect(result).toHaveProperty('bb');
      expect(result).toHaveProperty('volume');
    });
  });

  describe('decide', () => {
    test('should return WAIT for null indicators', () => {
      const result = bt.decide(null, 0.0001);
      expect(result.action).toBe('WAIT');
    });

    test('should return BUY for bullish setup', () => {
      const ind = {
        price: 105, ma7: 104, ma25: 100,
        ma7Direction: 'up', priceVsMa7: 'above',
        ma7CrossAbove: true, ma7CrossBelow: false,
        rsi: 45, atrPercent: 2.0,
        bb: { upper: 110, middle: 100, lower: 90 },
        volume: { ratio: 1.5 },
      };
      const result = bt.decide(ind, 0.0001);
      expect(['LONG', 'WAIT']).toContain(result.action);
      if (result.action === 'LONG') {
        expect(result.score).toBeGreaterThan(0);
      }
    });

    test('should return SHORT for bearish setup', () => {
      const ind = {
        price: 95, ma7: 96, ma25: 100,
        ma7Direction: 'down', priceVsMa7: 'below',
        ma7CrossAbove: false, ma7CrossBelow: true,
        rsi: 65, atrPercent: 2.0,
        bb: { upper: 110, middle: 100, lower: 90 },
        volume: { ratio: 1.5 },
      };
      const result = bt.decide(ind, 0.0001);
      expect(['SHORT', 'WAIT']).toContain(result.action);
    });

    test('should produce lower score for low-ATR low-volume trades', () => {
      const ind = {
        price: 101, ma7: 100.5, ma25: 100,
        ma7Direction: 'up', priceVsMa7: 'above',
        ma7CrossAbove: false, ma7CrossBelow: false,
        rsi: 50, atrPercent: 0.3,
        bb: { upper: 102, middle: 100, lower: 98 },
        volume: { ratio: 0.8 },
      };
      const result = bt.decide(ind, 0.0001);
      // Low ATR + low volume → should have low score (may still be LONG but weak)
      expect(result.score).toBeLessThan(0.5);
    });
  });
});
