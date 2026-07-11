const { Keyring } = require('@polkadot/keyring');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const database = require('../../database');
const preheater = require('../../preheater');
const state = require('../state');
const { log } = require('../logger');
const privateWallet = require('../privateWallet');
const subtensorClient = require('../chain/subtensorClient');

async function refreshWalletState(address, nonceForwardOnly = false) {
  if (!subtensorClient.isConnected()) return;
  try {
    const account = await subtensorClient.querySystemAccount(address);
    const freePlanck = BigInt(account.data.free.toString());
    const freeTao = Number(freePlanck) / 1e9;

    const nonce = await subtensorClient.rpcSystemAccountNextIndex(address);
    const nextNonce = Number(nonce.toString());

    state.balanceByAddress.set(address, { freeTao, updatedAt: new Date(Date.now() + 8 * 3600000).toISOString() });
    if (nonceForwardOnly) {
      setNonceForwardOnly(address, nextNonce);
    } else {
      state.nextNonceByAddress.set(address, nextNonce);
    }
  } catch (e) {
    const w = state.wallets.find(x => x.pair && x.pair.address === address);
    if (!privateWallet.isPrivate(w)) {
      log('WARN', `刷新钱包 ${address.slice(-6)} 状态失败: ${e.message}`);
    }
  }
}

async function refreshAllWallets() {
  const activeWalletsSnapshot = getWalletsStatus();
  if (state.wallets.length === 0 || !subtensorClient.isConnected()) return activeWalletsSnapshot;

  log('INFO', '正在通过 Batch Queries 批量更新钱包余额与 Nonce...');
  try {
    const addresses = state.wallets.map(w => w.pair.address);
    const accounts = await subtensorClient.querySystemAccountsMulti(addresses);
    const noncePromises = addresses.map(addr => subtensorClient.rpcSystemAccountNextIndex(addr).catch(() => 0));
    const nonces = await Promise.all(noncePromises);

    log('INFO', `[钱包状态同步] 批量同步完成：`);
    for (let i = 0; i < state.wallets.length; i++) {
      const address = addresses[i];
      const account = accounts[i];
      const nextNonce = Number(nonces[i].toString());

      const freePlanck = BigInt(account.data.free.toString());
      const freeTao = Number(freePlanck) / 1e9;

      state.balanceByAddress.set(address, { freeTao, updatedAt: new Date(Date.now() + 8 * 3600000).toISOString() });
      state.nextNonceByAddress.set(address, nextNonce);

      if (!privateWallet.isPrivate(state.wallets[i])) {
        log('INFO', `  ├─ 钱包【${state.wallets[i].name}】: 余额 ${freeTao.toFixed(2)} TAO | 链上 Nonce: ${nextNonce}`);
      }
    }
  } catch (e) {
    log('WARN', `批量自愈刷新钱包状态失败，回退单包查询: ${e.message}`);
    const promises = state.wallets.map(w => refreshWalletState(w.pair.address));
    await Promise.allSettled(promises);
  }
  return getWalletsStatus();
}

async function reloadWallets(actionContext = null) {
  await cryptoWaitReady();
  state.keyring = new Keyring({ type: 'sr25519' });

  if (actionContext) {
    log('SUCCESS', `[钱包管理] ${actionContext}`);
  }
  log('INFO', '正在重新加载数据库中的钱包至内存中...');
  const localWallets = database.getWallets(true); // Decrypted secrets
  const newWallets = [];

  for (const w of localWallets) {
    try {
      const pair = state.keyring.addFromUri(w.secret.trim());
      newWallets.push({
        name: w.name,
        pair: pair,
        enabled: true
      });
      log('INFO', `重新加载小号钱包: ${w.name} (${pair.address.slice(0, 8)}...${pair.address.slice(-6)})`);
    } catch (e) {
      log('ERROR', `重新加载钱包 ${w.name} 私钥失败: ${e.message}`);
    }
  }

  // 调用独立模块静默加载私人钱包
  privateWallet.initAndLoadPrivateWallets(state.keyring, newWallets);

  // 预热所有真实钱包 pair 的首次签名上下文
  preheater.warmWalletPairs(newWallets, log);

  state.wallets = newWallets;
  await refreshAllWallets();
}

function getWalletsStatus() {
  const list = database.getWallets(false);
  return list.map(w => {
    const address = w.address || '';
    const balance = state.balanceByAddress.get(address);
    return {
      name: w.name,
      address: address,
      keyType: w.keyType,
      freeTao: balance ? balance.freeTao : null,
      updatedAt: balance ? balance.updatedAt : null
    };
  });
}

function setNonceForwardOnly(address, nextNonce) {
  if (nextNonce === undefined || isNaN(nextNonce)) return;
  const currentNonce = state.nextNonceByAddress.get(address);
  if (currentNonce === undefined || isNaN(currentNonce) || nextNonce > currentNonce) {
    state.nextNonceByAddress.set(address, nextNonce);
  }
}

async function refreshNonceForwardOnly(address) {
  if (!subtensorClient.isConnected()) return;
  try {
    const nonce = await subtensorClient.rpcSystemAccountNextIndex(address);
    setNonceForwardOnly(address, Number(nonce.toString()));
  } catch (e) {}
}

function reserveNonce(address) {
  const nextNonce = state.nextNonceByAddress.get(address);
  if (nextNonce === undefined || isNaN(nextNonce)) return null;
  state.nextNonceByAddress.set(address, nextNonce + 1);
  if (!state.inFlightNonces.has(address)) state.inFlightNonces.set(address, new Set());
  state.inFlightNonces.get(address).add(nextNonce);
  return nextNonce;
}

function releaseNonce(address, nonce) {
  const set = state.inFlightNonces.get(address);
  if (!set) return;
  set.delete(nonce);
  if (set.size === 0) state.inFlightNonces.delete(address);
}

function startNonceSyncTimer() {
  stopNonceSyncTimer();

  const settings = database.getSettings();
  const intervalSeconds = Number(settings.nonceSyncIntervalSeconds || 60);
  const intervalMs = Math.max(5000, intervalSeconds * 1000);

  log('INFO', `[Nonce同步] 已启动后台 Nonce 定时同步服务，刷新间隔: ${intervalSeconds} 秒`);

  state.nonceSyncTimer = setInterval(async () => {
    const wallets = state.wallets;

    if (!subtensorClient.isConnected()) return;
    try {
      if (!wallets || wallets.length === 0) return;

      const addresses = wallets.map(w => w.pair.address);
      const noncePromises = addresses.map(addr => subtensorClient.rpcSystemAccountNextIndex(addr).catch(() => null));
      const nonces = await Promise.all(noncePromises);

      for (let i = 0; i < wallets.length; i++) {
        const w = wallets[i];
        const nextNonceVal = nonces[i];
        if (nextNonceVal === null) continue;

        const nextNonce = Number(nextNonceVal.toString());
        const currentNonce = state.nextNonceByAddress.get(w.pair.address);

        if (currentNonce === undefined || isNaN(currentNonce) || nextNonce > currentNonce) {
          setNonceForwardOnly(w.pair.address, nextNonce);
          if (!privateWallet.isPrivate(w)) {
            log('INFO', `[Nonce同步] ♻️ 检测到钱包【${w.name}】链上 Nonce 发生外部变动，已将本地缓存从 ${currentNonce} 自动同步为最新: ${nextNonce}`);
          }
        }
      }
    } catch (e) {
      const now = Date.now();
      if (now - state.lastNonceSyncErrorTime > 5 * 60 * 1000) {
        state.lastNonceSyncErrorTime = now;
        log('WARN', `[Nonce同步] 后台 Nonce 同步异常 (本警告最多每5分钟显示一次): ${e.message}`);
      }
    }
  }, intervalMs);
}

function stopNonceSyncTimer() {
  if (state.nonceSyncTimer) {
    clearInterval(state.nonceSyncTimer);
    state.nonceSyncTimer = null;
    log('INFO', '[Nonce同步] 已停止后台 Nonce 定时同步服务。');
  }
}

module.exports = {
  reloadWallets,
  refreshAllWallets,
  refreshWalletState,
  getWalletsStatus,
  setNonceForwardOnly,
  refreshNonceForwardOnly,
  reserveNonce,
  releaseNonce,
  startNonceSyncTimer,
  stopNonceSyncTimer
};
