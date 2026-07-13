/**
 * Kelly Position Sizing Tests
 */
const { KellyPosition } = require('../../saas/strategies/kelly-position');

describe('KellyPosition', () => {
  let kelly;

  beforeEach(() => {
    kelly = new KellyPosition({
      maxPositionPct: 0.25,
      minPositionPct: 0.05,
      maxRiskPerTrade: 0.02,
      kellyFraction: 0.5,
      maxDrawdown: 0.10,
    });
  });

  describe('calculateKelly', () => {
    test('should return positive kelly for winning strategy', () => {
      const result = kelly.calculateKelly(0.6, 0.03, 0.02);
      expect(result.kellyPct).toBeGreaterThan(0);
      expect(result.boundedKelly).toBeGreaterThan(0);
    });

    test('should return zero or negative for losing strategy', () => {
      const result = kelly.calculateKelly(0.3, 0.01, 0.03);
      expect(result.kellyPct).toBeLessThanOrEqual(0);
      expect(result.boundedKelly).toBeGreaterThanOrEqual(0);
    });

    test('should return positive for breakeven with good ratio', () => {
      const result = kelly.calculateKelly(0.5, 0.03, 0.01);
      expect(result.kellyPct).toBeGreaterThan(0);
    });

    test('should handle zero avgLoss gracefully', () => {
      const result = kelly.calculateKelly(0.6, 0.03, 0);
      expect(result).toBeDefined();
      expect(isNaN(result.kellyPct)).toBe(false);
    });

    test('should handle zero winRate gracefully', () => {
      const result = kelly.calculateKelly(0, 0.03, 0.02);
      expect(result.kellyPct).toBeLessThanOrEqual(0);
    });

    test('should apply half-kelly (kellyFraction = 0.5)', () => {
      const result = kelly.calculateKelly(0.7, 0.04, 0.02);
      expect(result.boundedKelly).toBeGreaterThan(0);
      expect(result.boundedKelly).toBeLessThanOrEqual(result.kellyPct + 0.001);
    });

    test('boundedKelly should not exceed maxPositionPct', () => {
      const result = kelly.calculateKelly(0.9, 0.10, 0.01);
      expect(result.boundedKelly).toBeLessThanOrEqual(0.25);
    });

    test('boundedKelly should not go below 0', () => {
      const result = kelly.calculateKelly(0.1, 0.01, 0.05);
      expect(result.boundedKelly).toBeGreaterThanOrEqual(0);
    });
  });

  describe('adjustForMarket', () => {
    test('should reduce position in extreme volatility', () => {
      const base = 0.15;
      const result = kelly.adjustForMarket(base, {
        volatility: 0.08,
        trendStrength: 0,
        rsi: 50,
        correlation: 0,
      });
      expect(result.adjustedKelly).toBeLessThan(base);
    });

    test('should reduce position in high volatility', () => {
      const base = 0.15;
      const result = kelly.adjustForMarket(base, {
        volatility: 0.04,
        trendStrength: 0,
        rsi: 50,
        correlation: 0,
      });
      expect(result.adjustedKelly).toBeLessThanOrEqual(base);
    });

    test('should maintain or increase position in low volatility with trend', () => {
      const base = 0.15;
      const result = kelly.adjustForMarket(base, {
        volatility: 0.005,
        trendStrength: 3.0,
        rsi: 55,
        correlation: 0,
      });
      expect(result.adjustedKelly).toBeGreaterThanOrEqual(base * 0.9);
    });
  });

  describe('updateDrawdown', () => {
    test('should detect drawdown beyond threshold', () => {
      kelly.peakEquity = 1000;
      const result = kelly.updateDrawdown(850);
      expect(result.drawdown).toBeGreaterThan(0.10);
      expect(result.shouldReduce).toBe(true);
    });

    test('should not trigger reduction within threshold', () => {
      kelly.peakEquity = 1000;
      const result = kelly.updateDrawdown(960);
      expect(result.shouldReduce).toBe(false);
    });

    test('should update peak when equity increases', () => {
      kelly.peakEquity = 1000;
      kelly.updateDrawdown(1200);
      expect(kelly.peakEquity).toBe(1200);
    });
  });
});
