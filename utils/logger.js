/**
 * Logger — Winston-based Structured Logging
 * 
 * Features:
 *   - JSON structured output
 *   - Console (colorized) + File (rotating) transports
 *   - Log levels: error, warn, info, debug, verbose
 *   - Module-scoped loggers (each module gets its own label)
 *   - Trade event logging (separate file)
 *   - Error tracking ready (can hook into Sentry later)
 */

const path = require('path');
const fs = require('fs');

let winston;
try {
  winston = require('winston');
} catch (e) {
  // Fallback: minimal console logger if winston not installed
  winston = null;
}

// Ensure log directory exists
const LOG_DIR = path.join(__dirname, '..', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch(e) {}

// ═══ Default format ═══
const jsonFormat = winston ? winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
) : null;

const consoleFormat = winston ? winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, module, ...meta }) => {
    const mod = module ? `[${module}]` : '';
    const metaStr = Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} ${level} ${mod} ${message}${metaStr}`;
  })
) : null;

// ═══ Create base logger ═══
let baseLogger;

if (winston) {
  baseLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: jsonFormat,
    defaultMeta: { service: 'masterd-quant' },
    transports: [
      // Console (human-readable)
      new winston.transports.Console({ format: consoleFormat }),
      // All logs (JSON)
      new winston.transports.File({ 
        filename: path.join(LOG_DIR, 'app.log'),
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
      }),
      // Errors only
      new winston.transports.File({ 
        filename: path.join(LOG_DIR, 'error.log'),
        level: 'error',
        maxsize: 5 * 1024 * 1024,
        maxFiles: 3,
      }),
    ],
  });
} else {
  // Minimal fallback
  baseLogger = {
    error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta || ''),
    warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta || ''),
    info: (msg, meta) => console.log(`[INFO] ${msg}`, meta || ''),
    debug: (msg, meta) => console.log(`[DEBUG] ${msg}`, meta || ''),
    verbose: (msg, meta) => console.log(`[VERBOSE] ${msg}`, meta || ''),
  };
}

// ═══ Module-scoped logger factory ═══
const loggers = new Map();

function createLogger(moduleName) {
  if (loggers.has(moduleName)) return loggers.get(moduleName);
  
  let logger;
  if (winston) {
    logger = baseLogger.child({ module: moduleName });
  } else {
    logger = {
      error: (msg, meta) => console.error(`[ERROR][${moduleName}] ${msg}`, meta || ''),
      warn: (msg, meta) => console.warn(`[WARN][${moduleName}] ${msg}`, meta || ''),
      info: (msg, meta) => console.log(`[INFO][${moduleName}] ${msg}`, meta || ''),
      debug: (msg, meta) => console.log(`[DEBUG][${moduleName}] ${msg}`, meta || ''),
      verbose: (msg, meta) => console.log(`[VERBOSE][${moduleName}] ${msg}`, meta || ''),
    };
  }
  
  loggers.set(moduleName, logger);
  return logger;
}

// ═══ Trade event logger (separate file) ═══
let tradeLogger;
if (winston) {
  tradeLogger = winston.createLogger({
    level: 'info',
    format: jsonFormat,
    transports: [
      new winston.transports.File({
        filename: path.join(LOG_DIR, 'trades.log'),
        maxsize: 10 * 1024 * 1024,
        maxFiles: 10,
      }),
    ],
  });
} else {
  tradeLogger = {
    info: (msg, meta) => console.log(`[TRADE] ${msg}`, meta || ''),
  };
}

// ═══ Export ═══
module.exports = {
  createLogger,
  tradeLogger,
  baseLogger,
  
  // Convenience: log trade event
  logTrade(event) {
    tradeLogger.info('trade_event', { 
      ...event, 
      timestamp: Date.now() 
    });
  },
  
  // Convenience: log error with context
  logError(module, error, context = {}) {
    const logger = createLogger(module);
    logger.error(error.message || String(error), { 
      stack: error.stack,
      ...context,
    });
  },
};
