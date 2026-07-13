/**
 * Config Loader — 安全配置加载
 * 
 * 1. 加载 .env 环境变量
 * 2. 读取 config/default.json
 * 3. 解析 ${VAR} 占位符为环境变量
 * 4. 验证必填项
 */
const fs = require('fs');
const path = require('path');

// Load .env
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {
  // dotenv not installed in production — rely on real env vars
}

function resolveEnvVars(obj) {
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string' && obj[key].startsWith('${') && obj[key].endsWith('}')) {
      const inner = obj[key].slice(2, -1);
      // Support default: ${VAR:default}
      const [envName, ...defaultParts] = inner.split(':');
      const defaultValue = defaultParts.length > 0 ? defaultParts.join(':') : '';
      obj[key] = process.env[envName] || defaultValue;
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      resolveEnvVars(obj[key]);
    }
  }
  return obj;
}

function loadConfig() {
  const configPath = path.join(__dirname, 'default.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  resolveEnvVars(config);

  // Validate critical fields (warn but don't crash — allows dev/test without keys)
  const warnings = [];
  if (!config.binance?.apiKey) warnings.push('BINANCE_API_KEY not set — CEX trading disabled');
  if (!config.binance?.apiSecret) warnings.push('BINANCE_API_SECRET not set — CEX trading disabled');
  if (!config.deepseek?.apiKey) warnings.push('DEEPSEEK_API_KEY not set — AI degraded to rule engine');
  
  if (warnings.length > 0) {
    console.log('[Config] ⚠️ Configuration warnings:');
    warnings.forEach(w => console.log(`  • ${w}`));
  } else {
    console.log('[Config] ✅ All required environment variables loaded');
  }

  return config;
}

module.exports = loadConfig();
module.exports.loadConfig = loadConfig;
module.exports.resolveEnvVars = resolveEnvVars;
