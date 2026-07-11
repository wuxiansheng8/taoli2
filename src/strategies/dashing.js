const database = require('../../database');
const state = require('../state');
const config = require('../config');
const { log, createTrace, traceLog } = require('../logger');
const { sendTelegramAlert } = require('../notifier');
const { executeStrategy } = require('./executor');
const subtensorClient = require('../chain/subtensorClient');
const subnetCache = require('../chain/subnetCache');
const privateWallet = require('../privateWallet');

async function handleRegisterNetwork(parsed) {
  try {
    if (!subtensorClient.isConnected()) return true;
    const netuidKeys = await subtensorClient.queryNetworksAddedKeys();
    const numSubnets = netuidKeys.length;
    let targetNetuid = null;

    if (numSubnets >= 128) {
      targetNetuid = await subnetCache.getNextPruneCandidate(state.currentBlockHeight);
    } else {
      const activeNetuids = new Set(netuidKeys.map(({ args: [netuid] }) => netuid.toNumber()));
      let candidate = 1;
      while (activeNetuids.has(candidate)) {
        candidate++;
      }
      targetNetuid = candidate;
    }

    if (targetNetuid !== null) {
      const actionKey = `dashing:${targetNetuid}`;
      const now = Date.now();
      if (state.hasAction(actionKey)) return true;
      state.markAction(actionKey, now);

      const isPruning = numSubnets >= 128;
      const oldName = isPruning ? subnetCache.getSubnetName(targetNetuid) : '';
      const statusStr = isPruning ? `清算替换 (原名: ${oldName})` : '空闲槽位注册';
      const tgMsg = `🚨 <b>[新子网注册 - 扫入交易池]</b>\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `• <b>目标槽位</b>: <code>SN#${targetNetuid}</code>\n` +
                    `• <b>首发状态</b>: <code>${statusStr}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `<i>⚠️ 检测到新子网已提交注册！请做好准备，等待所有者 startCall 激活以启动极速打新！</i>`;

      log('WARN', `🚨 [新子网注册 - 扫入交易池] 检测到新子网已提交注册！目标槽位: SN#${targetNetuid}, 状态: ${statusStr}`);
      sendTelegramAlert(tgMsg).catch(() => {});
      return true;
    }
  } catch (e) {
    log('ERROR', `处理新子网注册提醒判断错误: ${e.message}`);
    return true;
  }
}

async function handleStartCall(parsed, fallbackSource = 'Mempool', blockNum = null, triggerExtras = null) {
  const { args, signer } = parsed;
  const settings = config.getSettings();
  const now = Date.now();

  try {
    if (!subtensorClient.isConnected()) return false;
    const netuid = Number(args.netuid?.toString() || args[0]?.toString());
    if (Number.isFinite(netuid) && netuid > 0) {
      // 🔒 安全保护：校验交易发送者是否为该子网 the actual owner (Owner)
      let expectedOwner = subnetCache.getOwner(netuid);
      if (!expectedOwner) {
        try {
          const ownerObjs = await subtensorClient.querySubnetOwnersMulti([netuid]);
          expectedOwner = ownerObjs[0]?.toString();
        } catch (err) {
          log('WARN', `[新子网打新] 缓存和链上均无法获取子网 #${netuid} 的所有者，跳过所有者校验。`);
        }
      }
      if (expectedOwner && signer && signer !== expectedOwner) {
        log('WARN', `[新子网打新] 过滤非所有者发起的非法 startCall 交易：子网 #${netuid} 的实际所有者为 ${expectedOwner}，但提交者为 ${signer}`);
        return true; // 忽略
      }

      const actionKey = `startCall:${netuid}`;
      if (state.hasAction(actionKey)) return true;
      state.markAction(actionKey, now);

      const targetHotkey = await subnetCache.resolveHotkey(netuid);
      if (targetHotkey) {
        const triggerSrc = `${fallbackSource}-startCall`;
        const doubleStakingDelay = Number(settings.dashingDoubleStakingDelay || 0);
        const isFallback = fallbackSource === 'Block-Fallback';

        const title = isFallback ? `⚠️ <b>[区块兜底/漏扫补发 - 新子网打新]</b>` : `🔔 <b>[新子网打新 - 扫到激活交易]</b>`;
        const blockStr = isFallback && blockNum ? `• <b>漏扫区块</b>: <code>#${blockNum}</code>\n` : '';
        const footer = isFallback
          ? `<i>⚠️ 交易池已漏扫，正在执行区块后置补发买入...</i>`
          : `<i>🔥 策略 1 开启，立即启动极速打新！</i>`;

        const hasPublic = privateWallet.hasPublic(state.wallets.filter(w => w.enabled !== false));
        let primaryAfterBroadcast = null;
        if (settings.dashingEnabled) {
          if (hasPublic) {
            const tgMsg = `${title}\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `• <b>激活子网</b>: <code>SN#${netuid}</code>\n` +
                          `• <b>目标Hotkey</b>: <code>${targetHotkey}</code>\n` +
                          blockStr +
                          `• <b>触发来源</b>: <code>${triggerSrc}</code>\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `${footer}`;
            const trace = triggerExtras?.trace || createTrace();
            const afterBroadcast = triggerExtras?.afterBroadcast || [];
            primaryAfterBroadcast = afterBroadcast;
            traceLog(trace, 'INFO', `[新子网打新] 扫到所有者 startCall 激活交易 (${triggerSrc})！子网 #${netuid}，立即执行极速 Staking 抢购！`);
            afterBroadcast.push(() => sendTelegramAlert(tgMsg).catch(() => {}));
            executeStakingSniping(netuid, targetHotkey, triggerSrc, now, { trace, afterBroadcast }).catch(e => {
              log('ERROR', `[新子网打新] 触发 startCall 抢购失败: ${e.message}`);
            });
          } else {
            executeStakingSniping(netuid, targetHotkey, triggerSrc, now).catch(() => {});
          }
        } else {
          if (hasPublic) {
            log('INFO', `[新子网打新] 扫到所有者 startCall 激活交易 (${triggerSrc})。策略 1 主开关已关闭，跳过主线买入。`);

            const statusText = doubleStakingDelay > 0
              ? `主开关关闭，跳过主线买入（仅保留延迟 ${doubleStakingDelay} 秒买入）`
              : `策略 1 未开启，跳过打新买入`;

            const tgMsg = `⚠️ <b>[新子网打新 - 扫到激活交易]</b>\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `• <b>激活子网</b>: <code>SN#${netuid}</code>\n` +
                          `• <b>目标Hotkey</b>: <code>${targetHotkey}</code>\n` +
                          blockStr +
                          `• <b>触发来源</b>: <code>${triggerSrc}</code>\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `<i>⚠️ ${statusText}。</i>`;
            sendTelegramAlert(tgMsg).catch(() => {});
          }
        }

        // 执行二次延迟交易逻辑
        handleDoubleStaking(netuid, targetHotkey, fallbackSource, now, primaryAfterBroadcast);
      } else {
        log('WARN', `[新子网打新] 扫到 startCall 激活交易，但全局默认 Hotkey 未配置，取消抢跑。`);
      }
    }
    return true;
  } catch (e) {
    log('ERROR', `处理 startCall 抢跑判断错误: ${e.message}`);
    return false;
  }
}

async function executeStakingSniping(netuid, hotkey, triggerSource = 'Unknown', detectedAt = null, extraParams = null) {
  const settings = config.getSettings();
  const isDoubleStaking = extraParams?.isDoubleStaking === true;
  
  const strategyId = isDoubleStaking ? 'new-subnet-double' : 'new-subnet-primary';
  const label = isDoubleStaking ? '新子网打新:DoubleStaking' : '新子网打新:Primary';
  const maxPriceLimit = isDoubleStaking && settings.dashingDoubleMaxPrice !== undefined
    ? Number(settings.dashingDoubleMaxPrice || 0)
    : Number(settings.dashingMaxPrice || 0);

  const plan = {
    strategyId,
    netuid,
    hotkey,
    amountField: 'dashingAmount',
    burstCount: Math.max(1, settings.dashingBurstCount || 1),
    retries: Math.max(1, settings.dashingRetries || 10),
    intervalMs: Math.max(1, settings.dashingIntervalMs || 1000),
    timeoutMs: settings.dashingTimeoutMs || 30000,
    timeoutRetries: Math.max(0, settings.dashingTimeoutRetries || 0),
    priceMode: 'fixed',
    maxPriceLimit,
    label,
    extraParams: {
      ...extraParams,
      detectedAt: extraParams?.detectedAt || detectedAt,
      triggerSource
    }
  };

  return executeStrategy(plan);
}

function handleDoubleStaking(netuid, hotkey, source, detectedAt = null, afterPrimaryBroadcast = null) {
  const settings = config.getSettings();
  const delaySec = Number(settings.dashingDoubleStakingDelay || 0);
  if (delaySec > 0) {
    const activeWallets = state.wallets.filter(w => w.enabled !== false);
    const hasPublic = privateWallet.hasPublic(activeWallets);

    const cooldownKey = `new-subnet-double:${netuid}`;
    const cooldown = database.getCooldown(cooldownKey);
    if (cooldown) {
      const elapsed = Date.now() - cooldown.firstTriggeredAt;
      if (elapsed < 24 * 60 * 60 * 1000) {
        if (Math.abs(state.currentBlockHeight - cooldown.block) > 10) {
          if (hasPublic) {
            log('INFO', `[新子网打新] 检测到子网 #${netuid} 已有二次打新 24 小时冷却记录 (上次打新区块: #${cooldown.block}, 当前区块: #${state.currentBlockHeight})，跳过二次延时买入任务注册。`);
          }
          return;
        }
      }
    }

    if (state.doubleStakingRegistered.has(netuid)) {
      if (hasPublic) {
        log('INFO', `[新子网打新] 子网 #${netuid} 的二次延时买入任务已在运行，忽略重复注册请求。`);
      }
      return;
    }
    state.doubleStakingRegistered.add(netuid);
    if (hasPublic) {
      const msg = `[新子网打新] 已登记二次延时买入任务：将在 ${source} 触发 ${delaySec} 秒后再次执行买入。`;
      if (afterPrimaryBroadcast) {
        afterPrimaryBroadcast.push(() => log('INFO', msg));
      } else {
        log('INFO', msg);
      }
    }
    setTimeout(() => {
      state.doubleStakingRegistered.delete(netuid);
      if (state.botStatus !== 'Running') {
        if (hasPublic) {
          log('INFO', `[新子网打新] [二次延迟买入] 机器人未在运行状态，取消二次延迟交易。`);
        }
        return;
      }
      let triggerTrace = null;
      let triggerAfterBroadcast = null;
      if (hasPublic) {
        triggerTrace = createTrace();
        triggerAfterBroadcast = [];
        traceLog(triggerTrace, 'INFO', `[新子网打新] [二次延迟买入] 延时 ${delaySec} 秒已到，开始发起二次打新交易！`);
      }
      executeStakingSniping(netuid, hotkey, `DoubleStaking-${source}-Delay${delaySec}s`, detectedAt || Date.now(), {
        trace: triggerTrace,
        afterBroadcast: triggerAfterBroadcast,
        isDoubleStaking: true
      }).catch(e => {
        if (hasPublic) {
          log('ERROR', `[新子网打新] [二次延迟买入] 执行二次抢购失败: ${e.message}`);
        }
      });
    }, delaySec * 1000);
  }
}

module.exports = {
  handleRegisterNetwork,
  handleStartCall,
  executeStakingSniping,
  handleDoubleStaking
};
