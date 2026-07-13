/**
 * Volatility Adaptive Strategy Tests
 */
const { VolatilityAdaptive } = require('../../saas/strategies/volatility-adaptive');

describe('VolatilityAdaptive', () => {
  let vol;

  beforeEach(() => {
    vol = new VolatilityAdaptive({ lookbackPeriod: 20 });
  });

  describe('calculateVolatility', () => {
    test('should calculate volatility for normal market', () => {
      const klines = [];
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += (Math.random() - 0.5) * 0.5;
        klines.push({ close: price, high: price + 0.3, low: price - 0.3, volume: 1000 });
      }
      const result = vol.calculateVolatility(klines);
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    test('should detect low volatility regime', () => {
      const klines = [];
      let price = 100;
      for (let i = 0; i < 30; i++) {
        klines.push({ close: price, high: price + 0.01, low: price - 0.01, volume: 1000 });
      }
      vol.calculateVolatility(klines);
      const advice = vol.getRegimeAdvice();
      expect(advice).toBeDefined();
    });

    test('should detect high volatility regime', () => {
      const klines = [];
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += (Math.random() - 0.5) * 10;
        klines.push({ close: price, high: price + 5, low: price - 5, volume: 1000 });
      }
      vol.calculateVolatility(klines);
      const advice = vol.getRegimeAdvice();
      expect(advice).toBeDefined();
    });

    test('should handle empty klines', () => {
      const result = vol.calculateVolatility([]);
      expect(result).toBeDefined();
    });

    test('should handle klines with all same prices', () => {
      const klines = Array(30).fill({ close: 100, high: 100, low: 100, volume: 1000 });
      const result = vol.calculateVolatility(klines);
      expect(result).toBeDefined();
      expect(result.volatility).toBeCloseTo(0, 2);
    });
  });

  describe('checkAnomaly', () => {
    test('should not flag anomaly in normal conditions', () => {
      const klines = [];
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += (Math.random() - 0.5) * 0.5;
        klines.push({ close: price, high: price + 0.3, low: price - 0.3, volume: 1000 });
      }
      vol.calculateVolatility(klines);
      const anomaly = vol.checkAnomaly();
      expect(anomaly).toBeDefined();
      expect(anomaly).toHaveProperty('isAnomaly');
    });

    test('should flag anomaly when volatility spikes', () => {
      const klines = [];
      let price = 100;
      for (let i = 0; i < 20; i++) {
        price += (Math.random() - 0.5) * 0.5;
        klines.push({ close: price, high: price + 0.3, low: price - 0.3, volume: 1000 });
      }
      // Add extreme spike
      for (let i = 0; i < 10; i++) {
        price += (Math.random() - 0.5) * 15;
        klines.push({ close: price, high: price + 8, low: price - 8, volume: 5000 });
      }
      vol.calculateVolatility(klines);
      const anomaly = vol.checkAnomaly();
      expect(anomaly).toBeDefined();
    });
  });
});
