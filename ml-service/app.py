"""
MasterD LSTM Prediction Service
================================
Flask microservice that provides deep learning price predictions
for the Node.js quant trading engine.

Architecture:
  - LSTM (2-layer, 64 units each) with dropout
  - 60-bar lookback window → predict next-bar direction
  - 3-class output: UP / NEUTRAL / DOWN
  - Trained on historical klines via Binance API
  - ONNX export for potential JS-side inference

API:
  GET  /health        — health check
  POST /predict       — predict from klines array
  POST /train         — train/retrain model from historical data
  GET  /model/info    — model metadata
"""

import os
import sys
import json
import numpy as np
from datetime import datetime, timezone

# Flask
from flask import Flask, request, jsonify

# ML
try:
    import tensorflow as tf
    from tensorflow.keras.models import Sequential, load_model
    from tensorflow.keras.layers import LSTM, Dense, Dropout, BatchNormalization
    from tensorflow.keras.optimizers import Adam
    from tensorflow.keras.utils import to_categorical
    TF_AVAILABLE = True
except ImportError:
    TF_AVAILABLE = False
    print("⚠️ TensorFlow not available — service will run in fallback mode")

app = Flask(__name__)

# ═══════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════

MODEL_PATH = os.environ.get('MODEL_PATH', os.path.join(os.path.dirname(__file__), 'models', 'lstm_model.h5'))
LOOKBACK = 60        # 60 bars lookback
FEATURES = 5         # open, high, low, close, volume
NUM_CLASSES = 3      # UP, NEUTRAL, DOWN
LSTM_UNITS = 64
DROPOUT_RATE = 0.2
LEARNING_RATE = 0.001
BATCH_SIZE = 32
EPOCHS = 50

# Threshold for "neutral" class (±0.3% = neutral)
NEUTRAL_THRESHOLD = 0.003

model = None


# ═══════════════════════════════════════════
# Model Architecture
# ═══════════════════════════════════════════

def build_model():
    """Build LSTM model architecture"""
    if not TF_AVAILABLE:
        return None

    model = Sequential([
        LSTM(LSTM_UNITS, return_sequences=True, input_shape=(LOOKBACK, FEATURES)),
        BatchNormalization(),
        Dropout(DROPOUT_RATE),

        LSTM(LSTM_UNITS, return_sequences=False),
        BatchNormalization(),
        Dropout(DROPOUT_RATE),

        Dense(32, activation='relu'),
        Dropout(DROPOUT_RATE),

        Dense(NUM_CLASSES, activation='softmax')
    ])

    model.compile(
        optimizer=Adam(learning_rate=LEARNING_RATE),
        loss='categorical_crossentropy',
        metrics=['accuracy']
    )

    return model


def load_trained_model():
    """Load model from disk if exists"""
    global model
    if not TF_AVAILABLE:
        return False
    
    if os.path.exists(MODEL_PATH):
        try:
            model = load_model(MODEL_PATH)
            print(f"✅ Model loaded from {MODEL_PATH}")
            return True
        except Exception as e:
            print(f"⚠️ Failed to load model: {e}")
    
    # Build untrained model as fallback
    model = build_model()
    print("ℹ️ Using untrained model (call /train to train)")
    return model is not None


# ═══════════════════════════════════════════
# Feature Engineering
# ═══════════════════════════════════════════

def prepare_sequences(klines):
    """
    Convert raw klines to LSTM input sequences.
    
    Args:
        klines: list of {open, high, low, close, volume} dicts
    
    Returns:
        X: (n_samples, LOOKBACK, FEATURES) normalized
        y: (n_samples,) class labels [0=down, 1=neutral, 2=up]
    """
    if len(klines) < LOOKBACK + 1:
        return None, None

    # Extract OHLCV
    closes = np.array([k['close'] for k in klines], dtype=float)
    opens = np.array([k['open'] for k in klines], dtype=float)
    highs = np.array([k['high'] for k in klines], dtype=float)
    lows = np.array([k['low'] for k in klines], dtype=float)
    volumes = np.array([k.get('volume', 0) for k in klines], dtype=float)

    # Normalize: use percentage returns for price, log for volume
    closes_norm = np.diff(np.log(closes + 1e-10), prepend=closes[0])
    opens_norm = np.diff(np.log(opens + 1e-10), prepend=opens[0])
    highs_norm = np.diff(np.log(highs + 1e-10), prepend=highs[0])
    lows_norm = np.diff(np.log(lows + 1e-10), prepend=lows[0])
    
    # Volume normalization (z-score)
    vol_mean = np.mean(volumes)
    vol_std = np.std(volumes) + 1e-10
    volumes_norm = (volumes - vol_mean) / vol_std

    # Combine features
    features = np.column_stack([opens_norm, highs_norm, lows_norm, closes_norm, volumes_norm])

    # Create sequences
    X, y = [], []
    for i in range(LOOKBACK, len(klines)):
        X.append(features[i - LOOKBACK:i])
        # Label: next bar return
        future_return = (closes[i] - closes[i - 1]) / closes[i - 1]
        if future_return > NEUTRAL_THRESHOLD:
            y.append(2)  # UP
        elif future_return < -NEUTRAL_THRESHOLD:
            y.append(0)  # DOWN
        else:
            y.append(1)  # NEUTRAL

    return np.array(X), np.array(y)


def prepare_single_sequence(klines):
    """Prepare last LOOKBACK bars for prediction"""
    if len(klines) < LOOKBACK:
        return None

    closes = np.array([k['close'] for k in klines[-LOOKBACK - 1:]], dtype=float)
    opens = np.array([k['open'] for k in klines[-LOOKBACK - 1:]], dtype=float)
    highs = np.array([k['high'] for k in klines[-LOOKBACK - 1:]], dtype=float)
    lows = np.array([k['low'] for k in klines[-LOOKBACK - 1:]], dtype=float)
    volumes = np.array([k.get('volume', 0) for k in klines[-LOOKBACK - 1:]], dtype=float)

    closes_norm = np.diff(np.log(closes + 1e-10), prepend=closes[0])
    opens_norm = np.diff(np.log(opens + 1e-10), prepend=opens[0])
    highs_norm = np.diff(np.log(highs + 1e-10), prepend=highs[0])
    lows_norm = np.diff(np.log(lows + 1e-10), prepend=lows[0])
    
    vol_mean = np.mean(volumes)
    vol_std = np.std(volumes) + 1e-10
    volumes_norm = (volumes - vol_mean) / vol_std

    features = np.column_stack([opens_norm, highs_norm, lows_norm, closes_norm, volumes_norm])
    return features[-LOOKBACK:].reshape(1, LOOKBACK, FEATURES)


# ═══════════════════════════════════════════
# API Endpoints
# ═══════════════════════════════════════════

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'service': 'masterd-lstm',
        'tensorflow': TF_AVAILABLE,
        'model_loaded': model is not None,
        'model_path': MODEL_PATH,
        'model_exists': os.path.exists(MODEL_PATH),
        'timestamp': datetime.now(timezone.utc).isoformat(),
    })


@app.route('/predict', methods=['POST'])
def predict():
    """
    Predict next-bar direction from klines.
    
    Request body:
        {
            "klines": [{open, high, low, close, volume}, ...],
            "symbol": "BTCUSDT"  // optional
        }
    
    Response:
        {
            "direction": 1,       // -1=down, 0=neutral, 1=up
            "action": "BUY",      // BUY/SELL/HOLD
            "confidence": 0.75,   // 0-1
            "probabilities": {"down": 0.1, "neutral": 0.15, "up": 0.75},
            "valid": true
        }
    """
    try:
        data = request.get_json()
        klines = data.get('klines', [])
        symbol = data.get('symbol', 'unknown')

        if len(klines) < LOOKBACK:
            return jsonify({
                'valid': False,
                'error': f'Insufficient klines: {len(klines)} < {LOOKBACK}',
                'direction': 0,
                'action': 'HOLD',
                'confidence': 0,
            }), 200

        if not TF_AVAILABLE or model is None:
            # Fallback: simple momentum
            closes = [k['close'] for k in klines[-10:]]
            if len(closes) >= 2:
                momentum = (closes[-1] - closes[0]) / closes[0]
                if momentum > 0.002:
                    return jsonify({'direction': 1, 'action': 'BUY', 'confidence': 0.5, 'valid': False, 'fallback': 'momentum'})
                elif momentum < -0.002:
                    return jsonify({'direction': -1, 'action': 'SELL', 'confidence': 0.5, 'valid': False, 'fallback': 'momentum'})
            return jsonify({'direction': 0, 'action': 'HOLD', 'confidence': 0.3, 'valid': False, 'fallback': 'momentum'})

        # Prepare input
        X = prepare_single_sequence(klines)
        if X is None:
            return jsonify({'valid': False, 'error': 'feature prep failed', 'direction': 0, 'action': 'HOLD', 'confidence': 0}), 200

        # Predict
        probs = model.predict(X, verbose=0)[0]
        pred_class = np.argmax(probs)

        # Map: 0=down, 1=neutral, 2=up
        direction = 0
        action = 'HOLD'
        if pred_class == 2:
            direction = 1
            action = 'BUY'
        elif pred_class == 0:
            direction = -1
            action = 'SELL'

        confidence = float(probs[pred_class])

        return jsonify({
            'direction': direction,
            'action': action,
            'confidence': round(confidence, 4),
            'probabilities': {
                'down': round(float(probs[0]), 4),
                'neutral': round(float(probs[1]), 4),
                'up': round(float(probs[2]), 4),
            },
            'valid': True,
            'symbol': symbol,
            'lookback': LOOKBACK,
        })

    except Exception as e:
        return jsonify({
            'valid': False,
            'error': str(e),
            'direction': 0,
            'action': 'HOLD',
            'confidence': 0,
        }), 200


@app.route('/train', methods=['POST'])
def train():
    """
    Train/retrain the LSTM model from historical klines.
    
    Request body:
        {
            "klines": [{open, high, low, close, volume}, ...],
            "epochs": 50,        // optional
            "batch_size": 32     // optional
        }
    """
    try:
        if not TF_AVAILABLE:
            return jsonify({'error': 'TensorFlow not available', 'success': False}), 503

        data = request.get_json()
        klines = data.get('klines', [])
        epochs = data.get('epochs', EPOCHS)
        batch_size = data.get('batch_size', BATCH_SIZE)

        if len(klines) < LOOKBACK + 100:
            return jsonify({
                'error': f'Insufficient klines for training: {len(klines)} < {LOOKBACK + 100}',
                'success': False,
            }), 200

        # Prepare data
        X, y = prepare_sequences(klines)
        if X is None or len(X) == 0:
            return jsonify({'error': 'Feature preparation failed', 'success': False}), 200

        # Convert labels to categorical
        y_cat = to_categorical(y, num_classes=NUM_CLASSES)

        # Train/test split (80/20)
        split_idx = int(len(X) * 0.8)
        X_train, X_test = X[:split_idx], X[split_idx:]
        y_train, y_test = y_cat[:split_idx], y_cat[split_idx:]

        # Build fresh model
        global model
        model = build_model()

        # Train
        history = model.fit(
            X_train, y_train,
            validation_data=(X_test, y_test),
            epochs=epochs,
            batch_size=batch_size,
            verbose=1,
            shuffle=False,  # Time series — don't shuffle
        )

        # Save
        os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
        model.save(MODEL_PATH)

        # Evaluate
        test_loss, test_acc = model.evaluate(X_test, y_test, verbose=0)

        return jsonify({
            'success': True,
            'model_path': MODEL_PATH,
            'samples': len(X),
            'train_samples': len(X_train),
            'test_samples': len(X_test),
            'epochs': epochs,
            'final_train_loss': round(float(history.history['loss'][-1]), 4),
            'final_val_loss': round(float(history.history['val_loss'][-1]), 4),
            'final_train_acc': round(float(history.history['accuracy'][-1]), 4),
            'final_val_acc': round(float(history.history['val_accuracy'][-1]), 4),
            'test_loss': round(float(test_loss), 4),
            'test_accuracy': round(float(test_acc), 4),
            'class_distribution': {
                'down': int(np.sum(y == 0)),
                'neutral': int(np.sum(y == 1)),
                'up': int(np.sum(y == 2)),
            },
        })

    except Exception as e:
        return jsonify({'error': str(e), 'success': False}), 500


@app.route('/model/info', methods=['GET'])
def model_info():
    if model is None:
        return jsonify({'loaded': False, 'tensorflow': TF_AVAILABLE})
    
    info = {
        'loaded': True,
        'tensorflow': TF_AVAILABLE,
        'model_path': MODEL_PATH,
        'model_exists': os.path.exists(MODEL_PATH),
        'lookback': LOOKBACK,
        'features': FEATURES,
        'lstm_units': LSTM_UNITS,
        'num_classes': NUM_CLASSES,
        'total_params': model.count_params() if TF_AVAILABLE else 0,
    }
    return jsonify(info)


# ═══════════════════════════════════════════
# Main
# ═══════════════════════════════════════════

if __name__ == '__main__':
    port = int(os.environ.get('FLASK_PORT', 8100))
    
    print(f"🧠 MasterD LSTM Service starting on port {port}")
    print(f"   TensorFlow: {'✅' if TF_AVAILABLE else '❌'}")
    print(f"   Model path: {MODEL_PATH}")
    
    load_trained_model()
    
    # ═══ 境外云部署安全：默认只监听 127.0.0.1 ═══
    import os
    private_access = os.environ.get('PRIVATE_ACCESS', 'yes').lower()
    bind_host = '127.0.0.1' if private_access == 'yes' else '0.0.0.0'
    app.run(host=bind_host, port=port, debug=False)
