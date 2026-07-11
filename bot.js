const database = require('./database');
const state = require('./src/state');
const { log, getLogs } = require('./src/logger');
const { testTelegram, testFlashDuty } = require('./src/notifier');
const { testApiUrl } = require('./src/chain/subtensorClient');
const { refreshAllWallets, reloadWallets, getWalletsStatus } = require('./src/wallet/walletService');
const { startBot, stopBot } = require('./src/runtime');

function clearCooldown(strategy) {
  try {
    const clearedCount = database.clearCooldownsByStrategy(strategy);
    const clearedState = state.clearStrategyState(strategy);
    log('INFO', `[清理冷却] 清理了策略 [${strategy}] 的冷却与运行锁。已删除 ${clearedCount} 个持久化记录。`);
    return {
      success: true,
      clearedCount,
      memoryClearedCount: clearedState.memoryClearedCount,
      lockClearedCount: clearedState.lockClearedCount
    };
  } catch (e) {
    log('ERROR', `[清理冷却] 失败: ${e.message}`);
    return { success: false, error: e.message };
  }
}

module.exports = {
  startBot,
  stopBot,
  testTelegram,
  testFlashDuty,
  testApiUrl,
  refreshAllWallets,
  reloadWallets,
  getWalletsStatus,
  getWallets: () => state.wallets,
  log,
  getUptimeSeconds: () => state.getUptimeSeconds(),
  getLogs,
  getStatus: () => state.getStatusSnapshot(),
  setLogCallback: (cb) => { global.logCallback = cb; },
  setBlockCallback: (cb) => { global.blockCallback = cb; },
  clearCooldown
};
