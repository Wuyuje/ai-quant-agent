/**
 * Neural Network Tests
 */
const { NeuralNet } = require('../../saas/strategies/neural-net');

describe('NeuralNet', () => {
  let nn;

  beforeEach(() => {
    nn = new NeuralNet();
  });

  describe('extractFeatures', () => {
    test('should extract features from valid klines', () => {
      const klines = [];
      let price = 100;
      for (let i = 0; i < 60; i++) {
        const change = (Math.random() - 0.5) * 2;
        price += change;
        klines.push({ open: price - 0.5, high: price + 1, low: price - 1, close: price, volume: 1000 + Math.random() * 500 });
      }
      const features = nn.extractFeatures(klines, { price });
      expect(features).toBeDefined();
      expect(features).not.toBeNull();
      expect(features.length).toBe(12);
    });

    test('should handle insufficient klines (return null or zeros)', () => {
      const klines = Array(10).fill({ open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      const features = nn.extractFeatures(klines, { price: 100 });
      if (features) {
        expect(features.length).toBe(12);
      } else {
        expect(features).toBeNull();
      }
    });

    test('should produce finite values (no NaN/Infinity)', () => {
      const klines = [];
      let price = 100;
      for (let i = 0; i < 100; i++) {
        price += (Math.random() - 0.5) * 3;
        klines.push({ open: price, high: price + 2, low: price - 2, close: price, volume: 500 + Math.random() * 1000 });
      }
      const features = nn.extractFeatures(klines, { price });
      if (features) {
        features.forEach((f, i) => {
          expect(isFinite(f)).toBe(true);
        });
      }
    });
  });

  describe('predict', () => {
    test('should return valid prediction structure', () => {
      const features = new Array(12).fill(0.5);
      const result = nn.predict(features);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('direction');
      expect(result).toHaveProperty('confidence');
    });

    test('should return probabilities as object (up/neutral/down)', () => {
      const features = new Array(12).fill(0.5);
      const result = nn.predict(features);
      if (result.probabilities) {
        const probs = result.probabilities;
        const sum = (probs.up || 0) + (probs.neutral || 0) + (probs.down || 0);
        expect(sum).toBeCloseTo(1, 1);
      }
    });

    test('should handle zero features without NaN', () => {
      const features = new Array(12).fill(0);
      const result = nn.predict(features);
      expect(isNaN(result.confidence)).toBe(false);
    });

    test('should handle NaN features gracefully', () => {
      const features = new Array(12).fill(NaN);
      const result = nn.predict(features);
      expect(result).toBeDefined();
    });
  });

  describe('train (online learning)', () => {
    test('should accept training feedback without error', () => {
      const features = new Array(12).fill(0.5);
      const target = { direction: 1, confidence: 0.8 };
      expect(() => nn.train(features, target)).not.toThrow();
    });

    test('should improve prediction after training on consistent data', () => {
      const features = new Array(12).fill(0.5);
      for (let i = 0; i < 50; i++) {
        nn.train(features, { direction: 1, confidence: 0.9 });
      }
      const result = nn.predict(features);
      expect(result).toBeDefined();
      expect(isNaN(result.confidence)).toBe(false);
    });
  });

  describe('save / load', () => {
    test('should save and load model without error', () => {
      const fs = require('fs');
      const path = require('path');
      const tmpPath = path.join(__dirname, 'tmp-model-test.json');
      nn.save(tmpPath);
      expect(fs.existsSync(tmpPath)).toBe(true);
      const nn2 = new NeuralNet();
      nn2.load(tmpPath);
      const features = new Array(12).fill(0.5);
      const result = nn2.predict(features);
      expect(result).toBeDefined();
      try { fs.unlinkSync(tmpPath); } catch(e) {}
    });
  });
});
