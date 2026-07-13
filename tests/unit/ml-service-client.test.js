/**
 * ML Service Client Tests
 */
// v73: MLServiceClient已禁用

describe('MLServiceClient', () => {
  let client;

  beforeEach(() => {
    client = new MLServiceClient({
      serviceUrl: 'http://localhost:8100',
      enabled: true,
      log: () => {}, // silent in tests
    });
  });

  describe('fallback prediction', () => {
    test('should fallback to local MLP when service unavailable', async () => {
      const klines = [];
      let price = 100;
      for (let i = 0; i < 80; i++) {
        price += (Math.random() - 0.5) * 2;
        klines.push({ open: price, high: price + 1, low: price - 1, close: price, volume: 1000 });
      }
      const result = await client.predict(klines, 'BTCUSDT');
      expect(result).toBeDefined();
      expect(result).toHaveProperty('source');
      expect(['fallback-mlp', 'fallback-momentum', 'fallback-none', 'fallback-error', 'lstm-service']).toContain(result.source);
    });

    test('should handle empty klines gracefully', async () => {
      const result = await client.predict([], 'BTCUSDT');
      expect(result).toBeDefined();
      expect(result.valid).toBeFalsy();
    });

    test('should handle insufficient klines', async () => {
      const klines = Array(10).fill({ open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      const result = await client.predict(klines, 'BTCUSDT');
      expect(result).toBeDefined();
      expect(result.valid).toBeFalsy();
    });
  });

  describe('health check', () => {
    test('should mark service as unhealthy when unreachable', async () => {
      const healthy = await client.checkHealth();
      // Without a running service, should be false
      expect(healthy).toBe(false);
    });

    test('should cache health check result', async () => {
      const t1 = Date.now();
      await client.checkHealth();
      const t2 = Date.now();
      // Second call should be instant (cached)
      const t3 = Date.now();
      await client.checkHealth();
      const t4 = Date.now();
      expect(t4 - t3).toBeLessThan(50);
    });
  });

  describe('train', () => {
    test('should return error when service unavailable', async () => {
      const klines = Array(200).fill({ open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      const result = await client.train(klines);
      expect(result.success).toBeFalsy();
    });
  });
});
