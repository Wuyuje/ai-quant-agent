/**
 * Jest Configuration
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'engine.js',
    'saas/user-trader.js',
    'safety/guardian.js',
    'saas/strategies/strategy-manager.js',
    'saas/strategies/kelly-position.js',
    'saas/strategies/neural-net.js',
    'saas/strategies/volatility-adaptive.js',
    'backtest/backtest-engine.js',
    'config/loader.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  verbose: true,
  testTimeout: 15000,
};
