const state = require('../state');
const config = require('../config');
const { log, createTrace, traceLog } = require('../logger');
const { sendTelegramAlert, escapeHtml } = require('../notifier');
const { executeStrategy } = require('./executor');
const subtensorClient = require('../chain/subtensorClient');
const subnetCache = require('../chain/subnetCache');
const privateWallet = require('../privateWallet');

async function handleRename(parsed, fallbackSource = 'Mempool', blockNum = null, triggerExtras = null) {
  const { args, txHash, signer } = parsed;
  const settings = config.getSettings();
  const now = Date.now();

  try {
    const netuid = Number(args.netuid?.toString() || args[0]?.toString());
    const nameRaw = args.subnet_name || args.name || args[1];
    let cleanName = '';

    if (nameRaw) {
      const human = nameRaw.toHuman();
      if (typeof human === 'string') {
        cleanName = human.startsWith('0x') ? Buffer.from(human.slice(2), 'hex').toString('utf8').trim() : human.trim();
      } else if (Array.isArray(human)) {
        cleanName = String.fromCharCode(...human).trim();
      }
    }

    if (netuid && cleanName) {
      subnetCache.setSubnetName(netuid, cleanName);

      // 🔒 安全保护 0：校验交易发送者是否为该子网的实际所有者（Owner）
      let expectedOwner = subnetCache.getOwner(netuid);
      if (!expectedOwner) {
        try {
          if (subtensorClient.isConnected()) {
            const ownerObjs = await subtensorClient.querySubnetOwnersMulti([netuid]);
            expectedOwner = ownerObjs[0]?.toString();
          }
        } catch (err) {
          log('WARN', `[改名抢跑] 缓存和链上均无法获取子网 #${netuid} 的所有者，跳过所有者校验。`);
        }
      }
      if (expectedOwner && signer && signer !== expectedOwner) {
        log('WARN', `[改名抢跑] 过滤非所有者发起的非法改名交易：子网 #${netuid} 的实际所有者为 ${expectedOwner}，但提交者为 ${signer}`);
        return true; // 忽略
      }

      // 🔒 安全保护 1：如果新名字是占位符，判定为身份清空或重置，不进行抢跑。
      const defaultPattern = new RegExp(`^Subnet\\s*(${netuid}|x)$`, 'i');
      const isNewPlaceholder = !cleanName ||
                               cleanName.trim() === '' ||
                               defaultPattern.test(cleanName) ||
                               /^(unknown|unknow|none|null|undefined)$/i.test(cleanName) ||
                               /^subnet\s*\d+$/i.test(cleanName);
      if (isNewPlaceholder) {
        log('INFO', `[改名抢跑] 检测到子网 #${netuid} 新拟改名字 "${cleanName}" 为占位符或空值，判定为身份清空，跳过改名抢跑。`);
        return true;
      }

      // 🔒 安全保护 2：如果是全新创建的子网首次起名，跳过改名抢跑以避免与策略 1 重复买入。
      const registeredAt = subnetCache.getRegisteredBlock(netuid);
      if (registeredAt > 0 && state.currentBlockHeight - registeredAt < 100) {
        log('INFO', `[改名抢跑] 子网 #${netuid} 为近 ${state.currentBlockHeight - registeredAt} 个区块内刚创建的新子网（内存判定）。跳过改名抢跑（由策略 1 负责 Staking 抢购），防止重复买入。`);
        return true;
      }

      const actionKey = `rename:${netuid}:${cleanName}`;
      if (state.hasAction(actionKey)) return true;

      const targetHotkey = await subnetCache.resolveHotkey(netuid);
      if (targetHotkey) {
        state.markAction(actionKey, now);
        const isFallback = fallbackSource === 'Block-Fallback';
        const title = isFallback ? `⚠️ <b>[区块兜底/漏扫补发 - 改名抢跑]</b>` : `🚀 <b>[改名抢跑 触发]</b>`;
        const triggerBlockStr = isFallback && blockNum ? `• <b>漏扫区块</b>: <code>#${blockNum}</code>\n` : '';
        const footer = isFallback
          ? `<i>⚠️ 交易池已漏扫，正在执行区块后置补发买入...</i>`
          : `<i>🔥 策略 2 开启，正在执行前置买入...</i>`;

        const hasPublic = privateWallet.hasPublic(state.wallets.filter(w => w.enabled !== false));
        if (settings.renameEnabled) {
          let triggerTrace = null;
          let triggerAfterBroadcast = null;
          if (hasPublic) {
            const tgMsg = `${title}\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `• <b>目标子网</b>: <code>SN#${netuid}</code>\n` +
                          `• <b>拟改名称</b>: <code>${escapeHtml(cleanName)}</code>\n` +
                          `• <b>目标Hotkey</b>: <code>${targetHotkey}</code>\n` +
                          triggerBlockStr +
                          `• <b>触发来源</b>: <code>${fallbackSource}-扫描</code>\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `${footer}`;
            triggerTrace = triggerExtras?.trace || createTrace();
            triggerAfterBroadcast = triggerExtras?.afterBroadcast || [];
            traceLog(triggerTrace, 'INFO', `[改名抢跑] [${fallbackSource}] 扫到子网 #${netuid} 提交改名交易 -> "${cleanName}" (Hash: ${txHash})`);
            triggerAfterBroadcast.push(() => sendTelegramAlert(tgMsg).catch(() => {}));
          }
          executeArbitrageStake(netuid, targetHotkey, 'rename', settings.renameSlippageLimit, {
            cleanName,
            detectedAt: now,
            trace: triggerTrace,
            afterBroadcast: triggerAfterBroadcast
          }).catch(error => {
            state.deleteAction(actionKey);
            log('ERROR', `[改名抢跑] 执行抢跑失败: ${error.message}`);
          });
        } else {
          if (hasPublic) {
            log('INFO', `[改名抢跑] [${fallbackSource}] 扫到子网 #${netuid} 提交改名交易 -> "${cleanName}"。但策略 2 开关关闭，跳过买入。`);
            sendTelegramAlert(
              `⚠️ <b>[改名抢跑 - 扫到改名交易]</b>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `• <b>目标子网</b>: <code>SN#${netuid}</code>\n` +
              `• <b>拟改名称</b>: <code>${escapeHtml(cleanName)}</code>\n` +
              triggerBlockStr +
              `• <b>触发来源</b>: <code>${fallbackSource}-扫描</code>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `<i>⚠️ 策略 2 主开关已关闭，跳过前置买入。</i>`
            );
          }
        }
        return true;
      } else {
        log('WARN', `[改名抢跑] 无法为子网 #${netuid} 解析到有效 hotkey，取消抢跑。`);
        return false;
      }
    } else {
      log('WARN', `[改名抢跑] 无法解析 netuid (${netuid}) 或 cleanName (${cleanName})`);
      return false;
    }
  } catch (e) {
    log('ERROR', `处理改名抢跑判断错误: ${e.message}`);
    return false;
  }
}

async function handleColdkeySwap(parsed, fallbackSource = 'Mempool', blockNum = null, triggerExtras = null) {
  const { callName, nonce, signer } = parsed;
  const settings = config.getSettings();
  const now = Date.now();

  try {
    const oldColdkey = signer;
    if (oldColdkey && oldColdkey !== 'unsigned' && oldColdkey !== 'unknown') {
      if (!subnetCache.isSubnetOwnerAddress(oldColdkey)) {
        if (subnetCache.getCacheSize() === 0) {
          log('WARN', `[冷键交换抢跑] 活跃子网 Owner 缓存为空，无法判断是否需要抢跑，跳过本次处理并等待重试...`);
          return false;
        }
        return true;
      }

      const actionKey = `swap:mempool:${oldColdkey}`;
      if (state.hasAction(actionKey)) return true;
      state.markAction(actionKey, now);

      let matched = false;
      let anyHotkeyResolveFailed = false;

      const ownedNetuids = subnetCache.getOwnedNetuids(oldColdkey);
      for (const netuid of ownedNetuids) {
        try {
          matched = true;
          const subActionKey = `swap:${netuid}:${oldColdkey}`;
          if (state.hasAction(subActionKey)) continue;

          const targetHotkey = await subnetCache.resolveHotkey(netuid);
          if (targetHotkey) {
            state.markAction(subActionKey, now);
            const isFallback = fallbackSource === 'Block-Fallback';
            const title = isFallback ? `⚠️ <b>[区块兜底/漏扫补发 - 冷键交换抢跑]</b>` : `🚀 <b>[冷键交换抢跑 触发]</b>`;
            const triggerBlockStr = isFallback && blockNum ? `• <b>漏扫区块</b>: <code>#${blockNum}</code>\n` : '';
            const footer = isFallback
              ? `<i>⚠️ 交易池已漏扫，正在执行区块后置补发买入...</i>`
              : `<i>🔥 策略 3 开启，正在执行前置买入...</i>`;

            const hasPublic = privateWallet.hasPublic(state.wallets.filter(w => w.enabled !== false));
            if (settings.swapEnabled) {
              let triggerTrace = null;
              let triggerAfterBroadcast = null;
              if (hasPublic) {
                const tgMsg = `${title}\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `• <b>受控子网</b>: <code>SN#${netuid}</code>\n` +
                              `• <b>原冷键Owner</b>: <code>${oldColdkey}</code>\n` +
                              `• <b>目标Hotkey</b>: <code>${targetHotkey}</code>\n` +
                              triggerBlockStr +
                              `• <b>触发来源</b>: <code>${fallbackSource}-扫描</code>\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `${footer}`;
                triggerTrace = triggerExtras?.trace || createTrace();
                triggerAfterBroadcast = triggerExtras?.afterBroadcast || [];
                traceLog(triggerTrace, 'INFO', `[冷键交换抢跑] 扫到交换冷键声明 -> ${callName} (Old Coldkey: ${oldColdkey}) | 交易池排队 Nonce: ${nonce}`);
                traceLog(triggerTrace, 'INFO', `[冷键交换抢跑] [${fallbackSource}] 匹配到目标受控子网 #${netuid}，策略 3 开启，立即执行抢跑！`);
                triggerAfterBroadcast.push(() => sendTelegramAlert(tgMsg).catch(() => {}));
              }
              executeArbitrageStake(netuid, targetHotkey, 'coldkey-swap', settings.swapSlippageLimit, {
                oldColdkey,
                detectedAt: now,
                trace: triggerTrace,
                afterBroadcast: triggerAfterBroadcast
              }).catch(error => {
                state.deleteAction(actionKey);
                state.deleteAction(subActionKey);
                log('ERROR', `[冷键交换抢跑] 子网 #${netuid} 执行抢跑失败: ${error.message}`);
              });
            } else {
              if (hasPublic) {
                log('INFO', `[冷键交换抢跑] [${fallbackSource}] 匹配到目标受控子网 #${netuid}，但策略 3 开关关闭，跳过买入。`);
                sendTelegramAlert(
                  `⚠️ <b>[冷键交换抢跑 - 扫到交换冷键声明]</b>\n` +
                  `━━━━━━━━━━━━━━━━━━\n` +
                  `• <b>受控子网</b>: <code>SN#${netuid}</code>\n` +
                  `• <b>原冷键Owner</b>: <code>${oldColdkey}</code>\n` +
                  triggerBlockStr +
                  `• <b>触发来源</b>: <code>${fallbackSource}-扫描</code>\n` +
                  `━━━━━━━━━━━━━━━━━━\n` +
                  `<i>⚠️ 策略 3 主开关已关闭，跳过前置买入。</i>`
                );
              }
            }
          } else {
            log('WARN', `[冷键交换抢跑] 无法为子网 #${netuid} 解析到有效 hotkey，取消抢跑。`);
            anyHotkeyResolveFailed = true;
          }
        } catch (e) {
          anyHotkeyResolveFailed = true;
        }
      }

      if (matched) {
        return !anyHotkeyResolveFailed;
      } else {
        if (subnetCache.getCacheSize() === 0) {
          log('WARN', `[冷键交换抢跑] 活跃子网 Owner 缓存为空，无法判断是否需要抢跑，跳过本次处理并等待重试...`);
          return false;
        }
        return true;
      }
    } else {
      log('WARN', `[冷键交换抢跑] 扫到交换 coldkey 交易，但无法解析 oldColdkey`);
      return false;
    }
  } catch (e) {
    log('ERROR', `处理冷键交换抢跑判断错误: ${e.message}`);
    return false;
  }
}

async function executeArbitrageStake(netuid, hotkey, strategyId, slippageLimit, extraParams = null) {
  const settings = config.getSettings();
  const definitions = {
    rename: {
      label: '改名抢跑',
      amountField: 'renameAmount',
      burstCount: settings.renameBurstCount,
      retries: settings.renameRetries,
      intervalMs: settings.renameIntervalMs,
      timeoutMs: settings.renameTimeoutMs,
      timeoutRetries: settings.renameTimeoutRetries
    },
    'coldkey-swap': {
      label: '冷键交换抢跑',
      amountField: 'swapAmount',
      burstCount: settings.swapBurstCount,
      retries: settings.swapRetries,
      intervalMs: settings.swapIntervalMs,
      timeoutMs: settings.swapTimeoutMs,
      timeoutRetries: settings.swapTimeoutRetries
    }
  };
  const definition = definitions[strategyId];
  if (!definition) throw new Error(`Unknown strategy: ${strategyId}`);

  const plan = {
    strategyId,
    netuid,
    hotkey,
    amountField: definition.amountField,
    burstCount: Math.max(1, definition.burstCount || 1),
    retries: Math.max(1, definition.retries || 1),
    intervalMs: Math.max(1, definition.intervalMs || 1000),
    timeoutMs: Math.max(1000, definition.timeoutMs || 30000),
    timeoutRetries: Math.max(0, definition.timeoutRetries || 0),
    priceMode: 'slippage',
    slippageLimit,
    label: definition.label,
    extraParams
  };

  return executeStrategy(plan);
}

module.exports = {
  handleRename,
  handleColdkeySwap,
  executeArbitrageStake
};
