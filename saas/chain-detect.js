/**
 * v14: 链接检测中间件
 * 
 * 功能：
 *   - 用户登录时检测 BSC 链接状态
 *   - TP 钱包签名验证链 ID
 *   - 防止在错误链上操作
 */
const BSC_CHAIN_ID = 56;

/**
 * 检测请求是否来自 BSC 主网
 * 从 TP 钱包签名消息中提取 chainId
 */
function detectChainFromSignature(message, signature) {
  try {
    // TP 钱包签名消息格式：`\n${domain}\n${chainId}\n...`
    // 提取 chainId
    const chainMatch = message.match(/chainId['":\s]*(\d+)/i);
    if (chainMatch) {
      return parseInt(chainMatch[1]);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Express 中间件：验证 BSC 链
 */
function requireBscChain(req, res, next) {
  const chainId = req.headers['x-chain-id'] || req.query.chainId;
  
  if (chainId && parseInt(chainId) !== BSC_CHAIN_ID) {
    return res.status(400).json({
      error: '请切换到 BSC 主网',
      expected: BSC_CHAIN_ID,
      received: parseInt(chainId),
      hint: '请在 TP 钱包中切换到 BSC (Binance Smart Chain)',
    });
  }
  
  next();
}

/**
 * 从登录消息中提取并验证链 ID
 */
function extractAndVerifyChain(loginMessage, signature) {
  const chainId = detectChainFromSignature(loginMessage, signature);
  
  if (chainId === null) {
    return { valid: false, chainId: null, error: '无法检测链 ID' };
  }
  
  if (chainId !== BSC_CHAIN_ID) {
    return { valid: false, chainId, error: `错误链: ${chainId}，需要 BSC (${BSC_CHAIN_ID})` };
  }
  
  return { valid: true, chainId, error: null };
}

module.exports = { requireBscChain, detectChainFromSignature, extractAndVerifyChain, BSC_CHAIN_ID };
