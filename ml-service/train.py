"""
LSTM Model Training Script
============================
Fetches historical klines from Binance and trains the LSTM model.

Usage:
    python train.py --symbol BTCUSDT --interval 1h --limit 1500
    python train.py --symbol ETHUSDT --interval 15m --limit 1500 --epochs 100
"""

import argparse
import sys
import json
import urllib.request
import numpy as np

# Add parent path for imports
sys.path.insert(0, '.')

from app import prepare_sequences, build_model, MODEL_PATH, LOOKBACK, NUM_CLASSES


def fetch_klines(symbol, interval, limit):
    """Fetch historical klines from Binance Futures API"""
    url = f"https://fapi.binance.com/fapi/v1/klines?symbol={symbol}&interval={interval}&limit={limit}"
    print(f"📡 Fetching {limit} klines from Binance: {symbol} {interval}...")
    
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = json.loads(resp.read())
    
    klines = []
    for k in raw:
        klines.append({
            'open': float(k[1]),
            'high': float(k[2]),
            'low': float(k[3]),
            'close': float(k[4]),
            'volume': float(k[5]),
        })
    
    print(f"✅ Got {len(klines)} klines")
    print(f"   Range: {klines[0]['close']:.2f} → {klines[-1]['close']:.2f}")
    return klines


def train_model(klines, epochs=50, batch_size=32):
    """Train the LSTM model"""
    import tensorflow as tf
    from tensorflow.keras.utils import to_categorical
    import os
    
    print(f"\n🧠 Preparing training data (lookback={LOOKBACK})...")
    X, y = prepare_sequences(klines)
    
    if X is None or len(X) == 0:
        print("❌ Not enough data for training")
        return None
    
    print(f"   Samples: {len(X)}")
    print(f"   Shape: X={X.shape}, y={y.shape}")
    print(f"   Class distribution: down={np.sum(y==0)}, neutral={np.sum(y==1)}, up={np.sum(y==2)}")
    
    # Train/test split
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = to_categorical(y[:split_idx], num_classes=NUM_CLASSES), to_categorical(y[split_idx:], num_classes=NUM_CLASSES)
    
    print(f"   Train: {len(X_train)}, Test: {len(X_test)}")
    
    # Build model
    model = build_model()
    print(f"\n🏗️ Model architecture:")
    model.summary()
    
    # Callbacks
    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor='val_loss',
            patience=10,
            restore_best_weights=True,
        ),
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor='val_loss',
            factor=0.5,
            patience=5,
            min_lr=0.0001,
        ),
    ]
    
    # Train
    print(f"\n🏋️ Training for {epochs} epochs...")
    history = model.fit(
        X_train, y_train,
        validation_data=(X_test, y_test),
        epochs=epochs,
        batch_size=batch_size,
        callbacks=callbacks,
        verbose=1,
        shuffle=False,
    )
    
    # Evaluate
    test_loss, test_acc = model.evaluate(X_test, y_test, verbose=0)
    print(f"\n📊 Final Results:")
    print(f"   Train Loss: {history.history['loss'][-1]:.4f}")
    print(f"   Val Loss:   {history.history['val_loss'][-1]:.4f}")
    print(f"   Train Acc:  {history.history['accuracy'][-1]:.4f}")
    print(f"   Val Acc:    {history.history['val_accuracy'][-1]:.4f}")
    print(f"   Test Loss:  {test_loss:.4f}")
    print(f"   Test Acc:   {test_acc:.4f}")
    
    # Overfitting check
    train_acc = history.history['accuracy'][-1]
    val_acc = history.history['val_accuracy'][-1]
    gap = train_acc - val_acc
    if gap > 0.15:
        print(f"   ⚠️ Overfitting detected (train-val gap = {gap:.1%})")
    else:
        print(f"   ✅ No significant overfitting (gap = {gap:.1%})")
    
    # Save
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    model.save(MODEL_PATH)
    print(f"\n💾 Model saved to {MODEL_PATH}")
    print(f"   Parameters: {model.count_params():,}")
    
    return {
        'samples': len(X),
        'train_samples': len(X_train),
        'test_samples': len(X_test),
        'train_acc': float(train_acc),
        'val_acc': float(val_acc),
        'test_acc': float(test_acc),
        'overfit_gap': float(gap),
        'params': model.count_params(),
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Train LSTM model for price prediction')
    parser.add_argument('--symbol', type=str, default='BTCUSDT', help='Trading symbol')
    parser.add_argument('--interval', type=str, default='1h', help='Kline interval (1m,5m,15m,1h,4h,1d)')
    parser.add_argument('--limit', type=int, default=1500, help='Number of klines')
    parser.add_argument('--epochs', type=int, default=50, help='Training epochs')
    parser.add_argument('--batch-size', type=int, default=32, help='Batch size')
    
    args = parser.parse_args()
    
    print(f"{'═' * 60}")
    print(f"  MasterD LSTM Training")
    print(f"  Symbol: {args.symbol}")
    print(f"  Interval: {args.interval}")
    print(f"  Klines: {args.limit}")
    print(f"  Epochs: {args.epochs}")
    print(f"{'═' * 60}")
    
    # Fetch data
    klines = fetch_klines(args.symbol, args.interval, args.limit)
    
    # Train
    result = train_model(klines, args.epochs, args.batch_size)
    
    if result:
        print(f"\n{'═' * 60}")
        print(f"  ✅ Training complete!")
        print(f"  Test accuracy: {result['test_acc']:.1%}")
        print(f"  Overfit gap: {result['overfit_gap']:.1%}")
        print(f"  Model: {MODEL_PATH}")
        print(f"{'═' * 60}")
