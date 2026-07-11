const state = require('../state');
const { log } = require('../logger');
const config = require('../config');
const { codecToSortableBigInt } = require('./parser');
const subtensorClient = require('./subtensorClient');

async function refreshSubnetOwnersCache() {
  if (!subtensorClient.isConnected()) return;
  try {
    const netuidKeys = await subtensorClient.queryNetworksAddedKeys();
    const activeNetuids = netuidKeys.map(({ args: [netuid] }) => netuid.toNumber());

    // 批量并发查询所有子网的 Owner 冷键、Owner Hotkey 以及注册区块号
    const [owners, ownerHotkeys, registeredBlocks] = await Promise.all([
      subtensorClient.querySubnetOwnersMulti(activeNetuids),
      subtensorClient.querySubnetOwnerHotkeysMulti(activeNetuids),
      subtensorClient.queryNetworkRegisteredAtMulti(activeNetuids)
    ]);

    const changes = [];
    const isFirstSync = state.subnetOwnersCache.size === 0;

    if (!isFirstSync) {
      // 1. 检测已有子网的属性变更或新增子网
      for (let i = 0; i < activeNetuids.length; i++) {
        const netuid = activeNetuids[i];
        const ownerStr = owners[i]?.toString();
        const hotkeyStr = ownerHotkeys[i]?.toString();
        const registeredBlock = Number(registeredBlocks[i]?.toString() || 0);

        const oldOwner = state.subnetOwnersCache.get(netuid);
        const oldHotkey = state.subnetHotkeysCache.get(netuid);
        const oldRegBlock = state.subnetRegisteredAtCache.get(netuid);

        if (oldOwner === undefined) {
          changes.push(`[子网变动] 检测到新子网上线：#${netuid} (Owner: ${ownerStr ? ownerStr.slice(0, 8) + '...' : '无'}, Hotkey: ${hotkeyStr ? hotkeyStr.slice(0, 8) + '...' : '无'}, 注册高度: ${registeredBlock})`);
        } else {
          if (ownerStr && oldOwner !== ownerStr) {
            changes.push(`[子网变动] 子网 #${netuid} 所有者 (Coldkey) 发生变更：${oldOwner.slice(0, 8)}... -> ${ownerStr.slice(0, 8)}...`);
          }
          if (hotkeyStr && hotkeyStr.length >= 47 && oldHotkey !== hotkeyStr) {
            changes.push(`[子网变动] 子网 #${netuid} 的 Hotkey 发生变更：${oldHotkey ? oldHotkey.slice(0, 8) + '...' : '无'} -> ${hotkeyStr.slice(0, 8)}...`);
          }
          if (registeredBlock > 0 && oldRegBlock !== registeredBlock) {
            changes.push(`[子网变动] 子网 #${netuid} 注册高度发生变更：${oldRegBlock || 0} -> ${registeredBlock} (可能被接管/回收)`);
          }
        }
      }

      // 2. 检测子网下线
      const newNetuidsSet = new Set(activeNetuids);
      for (const oldNetuid of state.subnetOwnersCache.keys()) {
        if (!newNetuidsSet.has(oldNetuid)) {
          changes.push(`[子网变动] 子网 #${oldNetuid} 已下线/删除`);
        }
      }
    }

    state.subnetOwnersCache.clear();
    state.subnetOwnerSet.clear();
    state.subnetOwnerNetuidsMap.clear();
    state.subnetHotkeysCache.clear();
    state.subnetRegisteredAtCache.clear();
    for (let i = 0; i < activeNetuids.length; i++) {
      const netuid = activeNetuids[i];
      const ownerStr = owners[i]?.toString();
      const hotkeyStr = ownerHotkeys[i]?.toString();
      const registeredBlock = Number(registeredBlocks[i]?.toString() || 0);

      if (ownerStr) {
        state.subnetOwnersCache.set(netuid, ownerStr);
        state.subnetOwnerSet.add(ownerStr);
        if (!state.subnetOwnerNetuidsMap.has(ownerStr)) {
          state.subnetOwnerNetuidsMap.set(ownerStr, []);
        }
        state.subnetOwnerNetuidsMap.get(ownerStr).push(netuid);
      }
      if (hotkeyStr && hotkeyStr.length >= 47) {
        state.subnetHotkeysCache.set(netuid, hotkeyStr);
      }
      if (registeredBlock > 0) {
        state.subnetRegisteredAtCache.set(netuid, registeredBlock);
      }
    }

    if (isFirstSync) {
      log('SUCCESS', `[缓存同步] 子网缓存初始化成功。已缓存 ${activeNetuids.length} 个子网的 Owner 账户、Hotkey 及注册高度信息。`);
    } else if (changes.length > 0) {
      for (const msg of changes) {
        log('SUCCESS', msg);
      }
      state.successfulSyncCount = 0; // 重置心跳计数
    } else {
      state.successfulSyncCount++;
      if (state.successfulSyncCount >= 10) {
        log('SUCCESS', `[缓存同步] 子网缓存运行正常（已连续 ${state.successfulSyncCount} 次同步无变化，心跳正常）。已缓存 ${activeNetuids.length} 个子网。`);
        state.successfulSyncCount = 0;
      }
    }
  } catch (e) {
    log('WARN', `[缓存同步] 自动同步子网 Owner 缓存失败: ${e.message}`);
  }
}

function isSubnetOwnerAddress(address) {
  if (!address) return false;
  return state.subnetOwnerSet.has(address);
}

async function getNextPruneCandidate(currentBlock) {
  if (!subtensorClient.isConnected()) return null;
  let pruneNetuidVal = null;

  // 路径 A: 尝试 Runtime API 路径
  pruneNetuidVal = await subtensorClient.callSubnetInfoGetSubnetToPrune();

  // 路径 B: 原始底层 JSON-RPC 调用
  if (pruneNetuidVal === null) {
    pruneNetuidVal = await subtensorClient.queryRawSubnetToPrune();
  }

  // 路径 C: 自定义 JSON-RPC 映射路径
  if (pruneNetuidVal === null) {
    pruneNetuidVal = await subtensorClient.rpcSubnetInfoGetSubnetToPrune();
  }

  if (pruneNetuidVal !== undefined && pruneNetuidVal !== null) {
    try {
      let pruneNetuid;
      if (typeof pruneNetuidVal.isSome === 'boolean') {
        if (pruneNetuidVal.isSome) {
          pruneNetuid = Number(pruneNetuidVal.unwrap().toString());
        }
      } else {
        const valStr = pruneNetuidVal.toString();
        pruneNetuid = valStr.startsWith('0x') ? parseInt(valStr, 16) : Number(valStr);
      }
      if (pruneNetuid !== undefined && !isNaN(pruneNetuid)) {
        log('INFO', `[子网注销候选] 通过 SubnetInfo 接口直接查询成功，目标 netuid: #${pruneNetuid}`);
        return pruneNetuid;
      }
    } catch (decodeErr) {
      log('WARN', `解析待注销子网返回值失败: ${decodeErr.message}，将降级至批量多包计算`);
    }
  }

  // 降级使用批量多包并发查询，按链上 get_network_to_prune 规则本地计算
  try {
    const networkEntries = await subtensorClient.queryNetworksAddedKeys();
    const activeNetuids = networkEntries.map(({ args: [netuid] }) => netuid.toNumber()).filter(netuid => netuid !== 0);

    if (activeNetuids.length === 0) return null;

    const [registeredAtVals, movingPriceVals, networkImmunityPeriodVal] = await Promise.all([
      subtensorClient.queryNetworkRegisteredAtMulti(activeNetuids),
      subtensorClient.querySubnetMovingPricesMulti(activeNetuids),
      subtensorClient.queryNetworkImmunityPeriod()
    ]);

    let bestCandidate = null;
    let lowestMovingPrice = null;
    let earliestRegisteredAt = null;

    for (let i = 0; i < activeNetuids.length; i++) {
      const netuid = activeNetuids[i];
      const registeredAtVal = registeredAtVals[i];
      const movingPriceVal = movingPriceVals[i];

      const registeredAt = Number(registeredAtVal?.toString() || 0);
      const networkImmunityPeriod = Number(networkImmunityPeriodVal?.toString() || 0);
      const movingPrice = codecToSortableBigInt(movingPriceVal);

      if (currentBlock >= registeredAt && currentBlock - registeredAt >= networkImmunityPeriod) {
        if (
          bestCandidate === null ||
          movingPrice < lowestMovingPrice ||
          (movingPrice === lowestMovingPrice && registeredAt < earliestRegisteredAt)
        ) {
          bestCandidate = netuid;
          lowestMovingPrice = movingPrice;
          earliestRegisteredAt = registeredAt;
        }
      }
    }
    return bestCandidate;
  } catch (err) {
    log('ERROR', `计算待注销子网候选失败: ${err.message}`);
    return null;
  }
}

async function getSubnetPrice(netuid) {
  if (!subtensorClient.isConnected()) return null;
  
  let priceVal = await subtensorClient.rpcSwapCurrentAlphaPrice(netuid);
  if (priceVal) return BigInt(priceVal.toString());

  priceVal = await subtensorClient.callGetSubnetInfoV2(netuid);
  if (priceVal && priceVal.isSome) {
    const unwrapped = priceVal.unwrap();
    if (unwrapped.price) return BigInt(unwrapped.price.toString());
  }

  priceVal = await subtensorClient.callGetSubnetInfo(netuid);
  if (priceVal && priceVal.isSome) {
    const unwrapped = priceVal.unwrap();
    if (unwrapped.price) return BigInt(unwrapped.price.toString());
  }

  return null;
}

function resolveHotkey(netuid) {
  const settings = config.getSettings();
  if (settings.defaultHotkey && settings.defaultHotkey.trim() !== '') {
    return settings.defaultHotkey.trim();
  }
  return null;
}

function getOwner(netuid) {
  return state.subnetOwnersCache.get(netuid);
}

function getOwnedNetuids(address) {
  return state.subnetOwnerNetuidsMap.get(address) || [];
}

function getRegisteredBlock(netuid) {
  return state.subnetRegisteredAtCache.get(netuid) || 0;
}

function setRegisteredBlock(netuid, block) {
  state.subnetRegisteredAtCache.set(netuid, block);
}

function getSubnetName(netuid) {
  return state.subnetNamesCache.get(netuid) || '未知';
}

function setSubnetName(netuid, name) {
  state.subnetNamesCache.set(netuid, name);
}

function getCacheSize() {
  return state.subnetOwnersCache.size;
}

function getRegisteredNetuids() {
  return Array.from(state.subnetRegisteredAtCache.keys());
}

module.exports = {
  refreshSubnetOwnersCache,
  isSubnetOwnerAddress,
  getNextPruneCandidate,
  getSubnetPrice,
  resolveHotkey,
  getOwner,
  getOwnedNetuids,
  getRegisteredBlock,
  setRegisteredBlock,
  getSubnetName,
  setSubnetName,
  getCacheSize,
  getRegisteredNetuids
};
