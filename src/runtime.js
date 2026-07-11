const state = require('./state');
const config = require('./config');
const { log } = require('./logger');
const subtensorClient = require('./chain/subtensorClient');
const walletService = require('./wallet/walletService');
const subnetCache = require('./chain/subnetCache');
const mempoolScanner = require('./scanners/mempoolScanner');
const blockScanner = require('./scanners/blockScanner');
const emissionWatcher = require('./strategies/emissionWatcher');
const preheater = require('../preheater');

async function startBot() {
  if (state.botStatus === 'Running' || state.botStatus === 'Starting') return;
  
  preheater.startPreheating(5, log).catch(e => {
    log('WARN', `[预热器] 启动异常: ${e.message || e}`);
  });

  await connect('User triggered start');
}

function stopBot() {
  state.botStatus = 'Stopped';
  log('INFO', '套利机器人正在关闭...');

  // 1. 停止扫描
  mempoolScanner.stop();
  blockScanner.stop();
  emissionWatcher.stop();

  // 2. 停止 Nonce 同步
  walletService.stopNonceSyncTimer();

  // 3. 停止预热
  preheater.stopPreheating();

  // 4. 清理连接
  state.connectGeneration++;
  state.isConnecting = false;
  state.clearTimers();

  for (const provider of state.broadcastProviders.values()) {
    try { provider.disconnect(); } catch (e) {}
  }
  state.broadcastProviders.clear();
  state.broadcastStatuses.clear();

  if (state.api) {
    try { state.api.disconnect(); } catch (e) {}
    state.api = null;
  }
  state.provider = null;
  state.currentActiveNode = 'Disconnected';
  state.currentLatency = -1;
  state.systemUptimeStart = null;
  state.activeTimeoutRetryNumByWallet.clear();
  
  log('INFO', '套利机器人已安全关闭。');
}

async function reconnect(reason) {
  mempoolScanner.stop();
  blockScanner.stop();
  emissionWatcher.stop();
  
  subtensorClient.disconnectForReconnect(reason, async (newReason) => {
    await reconnect(newReason);
  });
}

async function connect(reason) {
  const generation = state.connectGeneration + 1; // Anticipate the connectWs increase
  
  await subtensorClient.connectWs(reason, async (newReason) => {
    await reconnect(newReason);
  });

  if (state.connectGeneration !== generation || state.botStatus === 'Stopped') {
    return;
  }

  if (state.botStatus === 'Error' || !state.api) {
    return;
  }

  try {
    state.botStatus = 'Running';
    if (!state.systemUptimeStart) state.systemUptimeStart = Date.now();

    // 1. 测试 Unsafe RPC
    try {
      log('INFO', '[API初始化] 正在测试本地节点是否开启 Unsafe RPC 接口 (用于交易池 Pending 交易扫描)...');
      await subtensorClient.pendingExtrinsics();
      if (state.connectGeneration === generation && state.botStatus !== 'Stopped') {
        log('SUCCESS', '本地交易池 (Mempool) 监听接口测试成功：Unsafe RPC 已启用！');
      }
    } catch (err) {
      if (state.connectGeneration === generation && state.botStatus !== 'Stopped') {
        const errMsg = err.message || String(err);
        log('WARN', `[注意] 本地交易池监听接口测试失败: "${errMsg}"。如果该节点是你的交易网关，请确保节点启动命令配置了 --rpc-methods=Unsafe，否则机器人将无法监听 Pending 交易！`);
      }
    }

    if (state.connectGeneration !== generation || state.botStatus === 'Stopped') return;

    // 2. 加载小号钱包并同步
    log('INFO', '[API初始化] 正在加载本地小号钱包并同步链上 Nonce 与余额...');
    await walletService.reloadWallets();
    
    if (state.connectGeneration !== generation || state.botStatus === 'Stopped') return;

    // 3. 同步子网所有者缓存
    log('INFO', '[API初始化] 正在批量拉取链上所有活跃子网的注册区块、Owner 和 Hotkey 信息...');
    await subnetCache.refreshSubnetOwnersCache();
    
    if (state.connectGeneration !== generation || state.botStatus === 'Stopped') return;

    // 4. 配置广播组件
    log('INFO', '[API初始化] 正在配置多节点广播组件并启动节点延迟测试...');
    subtensorClient.initBroadcastNodes();
    
    if (state.broadcastLatencyTimer) clearInterval(state.broadcastLatencyTimer);
    state.broadcastLatencyTimer = setInterval(subtensorClient.testBroadcastNodes, 10000);
    
    if (state.broadcastLatencyTimeout) clearTimeout(state.broadcastLatencyTimeout);
    state.broadcastLatencyTimeout = setTimeout(() => {
      if (state.connectGeneration === generation && state.botStatus === 'Running') {
        subtensorClient.testBroadcastNodes().catch(() => {});
      }
    }, 2000);

    // 5. 拉取最新区块头
    log('INFO', '[API初始化] 正在主动拉取最新区块头以初始化区块高度与 Hash 缓存...');
    try {
      const initHeader = await subtensorClient.getHeader();
      if (state.connectGeneration === generation && state.botStatus !== 'Stopped') {
        state.currentBlockHeight = initHeader.number.toNumber();
        state.cachedBlockHash = initHeader.hash;
        log('SUCCESS', `[API初始化] 区块缓存初始化成功：最新区块高度 #${state.currentBlockHeight} | Hash: ${state.cachedBlockHash.toHex().slice(0, 15)}...`);
      }
    } catch (err) {
      if (state.connectGeneration === generation && state.botStatus !== 'Stopped') {
        log('WARN', `[API初始化] 预拉取最新区块头失败（将依赖随后的区块订阅自愈）: ${err.message}`);
      }
    }

    if (state.connectGeneration !== generation || state.botStatus === 'Stopped') return;

    await emissionWatcher.start();

    if (state.connectGeneration !== generation || state.botStatus === 'Stopped') return;

    log('SUCCESS', '[API初始化] 节点连接与全部初始化请求执行完毕！机器人正式进入 RUNNING 状态，已启动区块与交易池扫描！');

    // 6. 开启 Nonce 定时同步
    walletService.startNonceSyncTimer();

    // 7. 启动区块和交易池扫描
    await blockScanner.start();
    mempoolScanner.start();

    // 8. 启动延迟检测
    if (state.latencyTimer) clearInterval(state.latencyTimer);
    state.latencyTimer = setInterval(async () => {
      if (!subtensorClient.isConnected()) {
        await reconnect('Connection Dropped');
        return;
      }
      const start = Date.now();
      try {
        await subtensorClient.rpcSystemHealth();
        state.currentLatency = Date.now() - start;
      } catch (e) {
        state.currentLatency = -1;
        await reconnect(`Heartbeat Timeout (${e.message})`);
      }
    }, 10000);

  } catch (e) {
    state.botStatus = 'Error';
    log('ERROR', `连接初始化失败: ${e.message}`);
    if (state.api) {
      try { await state.api.disconnect(); } catch (err) {}
      state.api = null;
    }
    state.provider = null;
    subtensorClient.scheduleReconnect(async (newReason) => {
      await reconnect(newReason);
    });
  }
}

module.exports = {
  startBot,
  stopBot
};
