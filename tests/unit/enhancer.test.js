/**
 * Backtest Enhancer Tests — Slippage, Walk-Forward, Overfit, Monte Carlo
 */
const BacktestEnhancer = require('../../backtest/enhancer');

describe('BacktestEnhancer', () => {
  let enhancer;

  beforeEach(() => {
    enhancer = new BacktestEnhancer();
  });

  describe('Slippage Models', () => {
    test('linearSlippage should return base slippage for small orders', () => {
      const slippage = enhancer.linearSlippage(100, 50000000);
      expect(slippage).toBeGreaterThan(0);
      expect(slippage).toBeLessThan(0.01);
    });

    test('linearSlippage should increase for larger orders', () => {
      const small = enhancer.linearSlippage(100, 50000000);
      const large = enhancer.linearSlippage(1000000, 50000000);
      expect(large).toBeGreaterThan(small);
    });

    test('linearSlippage should handle zero volume gracefully', () => {
      const slippage = enhancer.linearSlippage(100, 0);
      expect(slippage).toBeGreaterThan(0);
      expect(isNaN(slippage)).toBe(false);
    });

    test('squareRootImpact should calculate impact for normal order', () => {
      const impact = enhancer.squareRootImpact(1000, 50000000, 0.02);
      expect(impact.slippagePct).toBeGreaterThan(0);
      expect(impact.slippagePct).toBeLessThan(5);
      expect(impact.model).toBe('sqrt');
    });

    test('squareRootImpact should increase with order size', () => {
      const small = enhancer.squareRootImpact(100, 50000000, 0.02);
      const large = enhancer.squareRootImpact(10000000, 50000000, 0.02);
      expect(large.slippagePct).toBeGreaterThan(small.slippagePct);
    });

    test('squareRootImpact should handle zero ADV', () => {
      const impact = enhancer.squareRootImpact(100, 0, 0.02);
      expect(impact.slippagePct).toBeGreaterThan(0);
      expect(impact.model).toBe('fallback');
    });

    test('estimateTotalCost should sum all cost components', () => {
      const cost = enhancer.estimateTotalCost(100, 50000000, 0.02, 0.0001, 4);
      expect(cost.fee).toBeGreaterThan(0);
      expect(cost.slippage).toBeGreaterThan(0);
      expect(cost.funding).toBeGreaterThan(0);
      expect(cost.total).toBeGreaterThan(0);
      expect(cost.totalPct).toBeGreaterThan(0);
    });
  });

  describe('Data Split', () => {
    test('splitData should split correctly at 70/30', () => {
      const klines = Array(100).fill({ close: 100 });
      const { train, test, splitIdx } = enhancer.splitData(klines, 0.7);
      expect(train.length).toBe(70);
      expect(test.length).toBe(30);
      expect(splitIdx).toBe(70);
    });

    test('splitData should handle 50/50 split', () => {
      const klines = Array(50).fill({ close: 100 });
      const { train, test } = enhancer.splitData(klines, 0.5);
      expect(train.length).toBe(25);
      expect(test.length).toBe(25);
    });
  });

  describe('Overfitting Detection', () => {
    test('should flag no overfitting when train and test are similar', () => {
      const result = enhancer.detectOverfitting(
        { sharpe: 1.5, winRate: 55, totalReturn: 10 },
        { sharpe: 1.3, winRate: 52, totalReturn: 8 }
      );
      expect(parseFloat(result.overfitScore)).toBeLessThan(35);
      expect(result.verdict).toContain('无过拟合');
    });

    test('should flag severe overfitting when test is much worse', () => {
      const result = enhancer.detectOverfitting(
        { sharpe: 3.0, winRate: 80, totalReturn: 50 },
        { sharpe: 0.3, winRate: 45, totalReturn: -5 }
      );
      expect(parseFloat(result.overfitScore)).toBeGreaterThan(60);
      expect(result.verdict).toContain('严重');
    });

    test('should flag critical when test loses money but train profits', () => {
      const result = enhancer.detectOverfitting(
        { sharpe: 2.0, winRate: 70, totalReturn: 30 },
        { sharpe: -0.5, winRate: 35, totalReturn: -15 }
      );
      expect(parseFloat(result.overfitScore)).toBeGreaterThan(35);
    });
  });

  describe('Monte Carlo Simulation', () => {
    test('should run simulation with valid trades', () => {
      const trades = Array(50).fill(0).map(() => ({
        pnl: (Math.random() - 0.4) * 2, // slight positive bias
      }));
      const result = enhancer.monteCarloSimulation(trades, 100, 100);
      expect(result.simulations).toBe(100);
      expect(result.returns).toBeDefined();
      expect(result.returns.mean).toBeDefined();
      expect(result.drawdown).toBeDefined();
      expect(result.bankruptcyProbability).toBeDefined();
    });

    test('should handle empty trades', () => {
      const result = enhancer.monteCarloSimulation([], 100, 100);
      expect(result.error).toBe('no_trades');
    });

    test('should detect high bankruptcy probability for losing strategy', () => {
      const trades = Array(100).fill(0).map(() => ({
        pnl: -2, // all losses
      }));
      const result = enhancer.monteCarloSimulation(trades, 100, 100);
      const bankProb = parseFloat(result.bankruptcyProbability);
      expect(bankProb).toBeGreaterThan(50);
    });

    test('should show low risk for winning strategy', () => {
      const trades = Array(100).fill(0).map(() => ({
        pnl: 1, // all wins
      }));
      const result = enhancer.monteCarloSimulation(trades, 100, 100);
      const bankProb = parseFloat(result.bankruptcyProbability);
      expect(bankProb).toBe(0);
      expect(result.riskLevel).toContain('低风险');
    });

    test('returns should be sorted for percentile calculation', () => {
      const trades = Array(20).fill(0).map(() => ({
        pnl: Math.random() * 2 - 0.5,
      }));
      const result = enhancer.monteCarloSimulation(trades, 100, 200);
      // p5 should be less than p95
      const p5 = parseFloat(result.returns.p5);
      const p95 = parseFloat(result.returns.p95);
      expect(p5).toBeLessThanOrEqual(p95);
    });
  });

  describe('Walk-Forward Summary', () => {
    test('should summarize empty results', () => {
      const summary = enhancer._summarizeWalkForward([]);
      expect(summary.overfitRisk).toBe('unknown');
    });

    test('should detect overfit risk from degradation', () => {
      const results = [
        { inSample: { sharpe: 2.0 }, outOfSample: { sharpe: 0.5 }, degradation: '75%' },
        { inSample: { sharpe: 1.5 }, outOfSample: { sharpe: 0.3 }, degradation: '80%' },
      ];
      const summary = enhancer._summarizeWalkForward(results);
      expect(summary.avgDegradation).toBeGreaterThan(60);
      expect(summary.overfitRisk).toContain('high');
    });
  });
});
