const { ApiPromise, WsProvider } = require('@polkadot/api');
const WebSocket = require('ws');
const state = require('../state');
const config = require('../config');
const { log } = require('../logger');

function initBroadcastNodes() {
  const settings = config.getSettings();
  const nodes = settings.broadcastNodes || [];

  // Close old connections
  for (const provider of state.broadcastProviders.values()) {
    try { provider.disconnect(); } catch (e) {}
  }
  state.broadcastProviders.clear();
  state.broadcastStatuses.clear();

  log('INFO', `正在初始化 ${nodes.length} 个备用广播节点...`);
  for (const url of nodes) {
    if (!url) continue;
    try {
      const prov = new WsProvider(url, false);
      state.broadcastProviders.set(url, prov);
      state.broadcastStatuses.set(url, { status: 'Disconnected', latency: -1 });

      prov.on('connected', () => {
        state.broadcastStatuses.set(url, { status: 'Connected', latency: -1 });
      });
      prov.on('disconnected', () => {
        state.broadcastStatuses.set(url, { status: 'Disconnected', latency: -1 });
      });
      prov.on('error', () => {
        state.broadcastStatuses.set(url, { status: 'Disconnected', latency: -1 });
      });

      prov.connect();
    } catch (err) {
      log('WARN', `初始化广播节点 ${url} 失败: ${err.message}`);
    }
  }
}

async function testBroadcastNodes() {
  if (state.botStatus !== 'Running') return;
  const settings = config.getSettings();
  const configuredNodes = settings.broadcastNodes || [];
  let changed = false;
  if (configuredNodes.length !== state.broadcastProviders.size) {
    changed = true;
  } else {
    for (const url of configuredNodes) {
      if (!state.broadcastProviders.has(url)) {
        changed = true;
        break;
      }
    }
  }

  if (changed) {
    initBroadcastNodes();
  }

  const promises = [];
  for (const [url, provider] of state.broadcastProviders.entries()) {
    const start = Date.now();
    const testPromise = new Promise(async (resolve) => {
      try {
        if (!provider.isConnected) {
          state.broadcastStatuses.set(url, { status: 'Disconnected', latency: -1 });
          return resolve();
        }
        await provider.send('system_health', []);
        const lat = Date.now() - start;
        state.broadcastStatuses.set(url, { status: 'Connected', latency: lat });
      } catch (e) {
        state.broadcastStatuses.set(url, { status: 'Disconnected', latency: -1 });
      }
      resolve();
    });
    promises.push(testPromise);
  }
  await Promise.allSettled(promises);

  if (global.blockCallback) {
    global.blockCallback(state.currentBlockHeight);
  }
}

function broadcastSignedTx(signedTxHex) {
  for (const [nodeUrl, provider] of state.broadcastProviders.entries()) {
    const status = state.broadcastStatuses.get(nodeUrl);
    if (status && status.status === 'Connected') {
      provider.send('author_submitExtrinsic', [signedTxHex]).catch((err) => {
        // Silent catch for broadcast failures
      });
    }
  }
}

function testApiUrl(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return resolve({ success: false, error: e.message });
    }

    let settled = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "system_health",
        params: []
      }));
    });

    ws.on('message', () => {
      if (settled) return;
      settled = true;
      const latency = Date.now() - start;
      ws.close();
      resolve({ success: true, latency });
    });

    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      resolve({ success: false, error: err.message });
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      resolve({ success: false, error: 'Connection Timeout' });
    }, 3000);
  });
}

function scheduleReconnect(reconnectCallback) {
  if (state.botStatus === 'Stopped') return;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  log('INFO', '将在 5 秒后尝试重新连接 API 节点...');
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.botStatus !== 'Stopped') {
      if (typeof reconnectCallback === 'function') {
        reconnectCallback('Auto Reconnect').catch(e => {
          log('ERROR', `自动重连异常: ${e.message}`);
        });
      }
    }
  }, 5000);
}

function disconnectForReconnect(reason, reconnectCallback) {
  log('WARN', `因 ${reason} 断开连接，准备自动重连...`);

  if (state.nonceSyncTimer) {
    clearInterval(state.nonceSyncTimer);
    state.nonceSyncTimer = null;
  }

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

  state.connectGeneration++;
  state.isConnecting = false;
  state.botStatus = 'Error';

  scheduleReconnect(reconnectCallback);
}

async function connectWs(reason = 'Normal Boot', reconnectCallback) {
  if (state.isConnecting) {
    log('INFO', `已经有一个连接流程在运行中，跳过本次连接请求 [原因: ${reason}]`);
    return;
  }
  state.isConnecting = true;
  const generation = ++state.connectGeneration;

  state.botStatus = 'Starting';
  log('INFO', `正在建立连接 [触发原因: ${reason}]...`);

  const settings = config.getSettings();
  const targets = [settings.primaryNode, settings.backupNode].filter(Boolean);

  if (targets.length === 0) {
    state.botStatus = 'Error';
    log('ERROR', '未配置任何 API 节点，请检查系统设置！');
    state.isConnecting = false;
    return;
  }

  let connected = false;
  for (const url of targets) {
    if (generation !== state.connectGeneration || state.botStatus === 'Stopped') {
      state.isConnecting = false;
      return;
    }
    try {
      log('INFO', `尝试连接节点: ${url}...`);
      state.currentActiveNode = url;

      const provider = new WsProvider(url, false);

      const connPromise = new Promise((resolve, reject) => {
        provider.on('connected', () => resolve(true));
        provider.on('error', (err) => reject(err));
        provider.connect();
      });

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection Timeout')), 6000));

      await Promise.race([connPromise, timeoutPromise]);
      if (generation !== state.connectGeneration || state.botStatus === 'Stopped') {
        try { provider.disconnect(); } catch (err) {}
        state.isConnecting = false;
        return;
      }

      const api = await ApiPromise.create({
        provider,
        rpc: {
          swap: {
            currentAlphaPrice: {
              description: 'Get current alpha price',
              params: [
                { name: 'netuid', type: 'u16' }
              ],
              type: 'u64'
            }
          }
        }
      });
      
      if (generation !== state.connectGeneration || state.botStatus === 'Stopped') {
        if (api) {
          try { await api.disconnect(); } catch (err) {}
        }
        state.isConnecting = false;
        return;
      }

      log('SUCCESS', `成功连接至节点: ${url} (链名称: ${api.runtimeChain || 'Subtensor'}, Spec版本: ${api.runtimeVersion?.specVersion || 'unknown'}, 创世哈希: ${api.genesisHash?.toHex().slice(0, 10)}...)`);
      state.provider = provider;
      state.api = api;
      connected = true;
      break;
    } catch (e) {
      log('WARN', `连接节点 ${url} 失败: ${e.message}`);
      state.provider = null;
      state.api = null;
    }
  }

  if (!connected) {
    state.botStatus = 'Error';
    log('ERROR', '所有配置的 API 节点均连接失败！');
    state.currentActiveNode = 'Disconnected';
    state.currentLatency = -1;
    state.systemUptimeStart = null;
    state.isConnecting = false;
    scheduleReconnect(reconnectCallback);
    return;
  }

  state.isConnecting = false;
}

// ============================================================================
// Unified Subtensor API Adapter Layer (Isolating state.api usage)
// ============================================================================

function isConnected() {
  return !!(state.api && state.api.isConnected);
}

async function queryNetworksAddedKeys() {
  if (!state.api) throw new Error('API not initialized');
  return state.api.query.subtensorModule.networksAdded.keys();
}

async function querySubnetOwnersMulti(netuids) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.query.subtensorModule.subnetOwner.multi(netuids);
}

async function querySubnetOwnerHotkeysMulti(netuids) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.query.subtensorModule.subnetOwnerHotkey.multi(netuids);
}

async function queryNetworkRegisteredAtMulti(netuids) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.query.subtensorModule.networkRegisteredAt.multi(netuids);
}

async function querySubnetMovingPricesMulti(netuids) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.query.subtensorModule.subnetMovingPrice.multi(netuids);
}

async function queryNetworkImmunityPeriod() {
  if (!state.api) throw new Error('API not initialized');
  return state.api.query.subtensorModule.networkImmunityPeriod();
}

function hasSubnetEmissionStorage() {
  return !!(state.api?.query?.subtensorModule?.subnetEmissionEnabled);
}

async function querySubnetEmissionEnabledMulti(netuids) {
  if (!hasSubnetEmissionStorage()) {
    throw new Error('Current runtime does not expose SubnetEmissionEnabled storage');
  }
  const storage = state.api.query.subtensorModule.subnetEmissionEnabled;
  return typeof storage.multi === 'function'
    ? storage.multi(netuids)
    : Promise.all(netuids.map(netuid => storage(netuid)));
}

function hasSudoKeyStorage() {
  return !!(state.api?.query?.sudo?.key);
}

async function subscribeSudoKey(callback) {
  if (!hasSudoKeyStorage()) {
    throw new Error('Current runtime does not expose sudo.key storage');
  }
  return state.api.query.sudo.key(callback);
}

async function queryProxyDefinitions(real) {
  if (!state.api?.query?.proxy?.proxies) {
    throw new Error('Runtime does not expose proxy.proxies');
  }
  return state.api.query.proxy.proxies(real);
}

async function queryProxyAnnouncements(delegate) {
  if (!state.api?.query?.proxy?.announcements) {
    throw new Error('Runtime does not expose proxy.announcements');
  }
  return state.api.query.proxy.announcements(delegate);
}

async function callProxyFilters(proxyTypeIndexes) {
  const runtimeApi = state.api?.call?.proxyFilterRuntimeApi;
  if (typeof runtimeApi?.getProxyFilters !== 'function') {
    throw new Error('Runtime does not expose ProxyFilterRuntimeApi');
  }
  return runtimeApi.getProxyFilters(proxyTypeIndexes);
}

async function callSubnetInfoGetSubnetToPrune() {
  if (!state.api) return null;
  try {
    if (state.api.call.subnetInfoRuntimeApi && state.api.call.subnetInfoRuntimeApi.getSubnetToPrune) {
      return await state.api.call.subnetInfoRuntimeApi.getSubnetToPrune();
    }
  } catch (err) {
    log('WARN', `通过 SubnetInfoRuntimeApi 运行时 API 查询失败: ${err.message}，将尝试其它路径...`);
  }
  return null;
}

async function rpcSubnetInfoGetSubnetToPrune() {
  if (!state.api) return null;
  try {
    if (state.api.rpc.subnetInfo && state.api.rpc.subnetInfo.getSubnetToPrune) {
      return await state.api.rpc.subnetInfo.getSubnetToPrune(null);
    }
  } catch (err) {
    log('WARN', `通过 api.rpc.subnetInfo 自定义 RPC 映射查询失败: ${err.message}`);
  }
  return null;
}

async function queryRawSubnetToPrune() {
  if (!state.api) return null;
  try {
    const providerInstance = state.api.rpc.provider || (state.api._rpcCore && state.api._rpcCore.provider);
    if (providerInstance && typeof providerInstance.send === 'function') {
      return await providerInstance.send('subnetInfo_getSubnetToPrune', [null]);
    }
  } catch (err) {
    log('WARN', `通过 WsProvider 原始 JSON-RPC (subnetInfo_getSubnetToPrune) 查询失败: ${err.message}，将尝试其它路径...`);
  }
  return null;
}

async function rpcSwapCurrentAlphaPrice(netuid) {
  if (!state.api) return null;
  try {
    if (state.api.rpc.swap && state.api.rpc.swap.currentAlphaPrice) {
      return await state.api.rpc.swap.currentAlphaPrice(netuid);
    }
  } catch (e) {
    log('WARN', `获取子网 #${netuid} rpcSwapCurrentAlphaPrice 价格失败: ${e.message}`);
  }
  return null;
}

async function callGetSubnetInfoV2(netuid) {
  if (!state.api) return null;
  try {
    if (state.api.call.subnetInfoRuntimeApi && state.api.call.subnetInfoRuntimeApi.getSubnetInfoV2) {
      return await state.api.call.subnetInfoRuntimeApi.getSubnetInfoV2(netuid);
    }
  } catch (e) {
    log('WARN', `获取子网 #${netuid} callGetSubnetInfoV2 价格失败: ${e.message}`);
  }
  return null;
}

async function callGetSubnetInfo(netuid) {
  if (!state.api) return null;
  try {
    if (state.api.call.subnetInfoRuntimeApi && state.api.call.subnetInfoRuntimeApi.getSubnetInfo) {
      return await state.api.call.subnetInfoRuntimeApi.getSubnetInfo(netuid);
    }
  } catch (e) {
    log('WARN', `获取子网 #${netuid} callGetSubnetInfo 价格失败: ${e.message}`);
  }
  return null;
}

async function querySystemAccount(address) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.query.system.account(address);
}

async function querySystemAccountsMulti(addresses) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.query.system.account.multi(addresses);
}

async function rpcSystemAccountNextIndex(address) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.rpc.system.accountNextIndex(address);
}

async function rpcSystemHealth() {
  if (!state.api) throw new Error('API not initialized');
  return state.api.rpc.system.health();
}

async function getHeader() {
  if (!state.api) throw new Error('API not initialized');
  return state.api.rpc.chain.getHeader();
}

async function getBlock(blockHash) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.rpc.chain.getBlock(blockHash);
}

async function querySystemEventsAt(blockHash) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.query.system.events.at(blockHash);
}

async function subscribeNewHeads(callback) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.rpc.chain.subscribeNewHeads(callback);
}

function hasAddStakeLimit() {
  return !!(state.api && state.api.tx && state.api.tx.subtensorModule && typeof state.api.tx.subtensorModule.addStakeLimit === 'function');
}

function buildAddStakeLimitTx(hotkey, netuid, amountBigInt, limitPrice, allowPartial) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.tx.subtensorModule.addStakeLimit(hotkey, netuid, amountBigInt, limitPrice, allowPartial);
}

function buildAddStakeTx(hotkey, netuid, amountBigInt) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.tx.subtensorModule.addStake(hotkey, netuid, amountBigInt);
}

function findMetaError(dispatchError) {
  if (!state.api) return null;
  return state.api.registry.findMetaError(dispatchError.asModule);
}

async function pendingExtrinsics() {
  if (!state.api) throw new Error('API not initialized');
  return state.api.rpc.author.pendingExtrinsics();
}

function createType(type, value) {
  if (!state.api) throw new Error('API not initialized');
  return state.api.createType(type, value);
}

module.exports = {
  connectWs,
  disconnectForReconnect,
  scheduleReconnect,
  broadcastSignedTx,
  testBroadcastNodes,
  initBroadcastNodes,
  testApiUrl,

  // Wrapper APIs
  isConnected,
  queryNetworksAddedKeys,
  querySubnetOwnersMulti,
  querySubnetOwnerHotkeysMulti,
  queryNetworkRegisteredAtMulti,
  querySubnetMovingPricesMulti,
  queryNetworkImmunityPeriod,
  hasSubnetEmissionStorage,
  querySubnetEmissionEnabledMulti,
  hasSudoKeyStorage,
  subscribeSudoKey,
  queryProxyDefinitions,
  queryProxyAnnouncements,
  callProxyFilters,
  callSubnetInfoGetSubnetToPrune,
  rpcSubnetInfoGetSubnetToPrune,
  queryRawSubnetToPrune,
  rpcSwapCurrentAlphaPrice,
  callGetSubnetInfoV2,
  callGetSubnetInfo,

  querySystemAccount,
  querySystemAccountsMulti,
  rpcSystemAccountNextIndex,
  rpcSystemHealth,

  getHeader,
  getBlock,
  querySystemEventsAt,
  subscribeNewHeads,

  hasAddStakeLimit,
  buildAddStakeLimitTx,
  buildAddStakeTx,
  findMetaError,
  pendingExtrinsics,
  createType
};
