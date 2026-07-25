const database = require('../../database');
const state = require('../state');
const config = require('../config');
const { log, createTrace, traceLog } = require('../logger');
const { sendTelegramAlert, sendFlashDutyAlert, escapeHtml } = require('../notifier');
const { buildFixedLimitStakeTx, buildStakeTx, sendStrategicTx } = require('../transaction/transactionService');
const privateWallet = require('../privateWallet');

const FLASH_DUTY_STRATEGY_TITLES = {
  'new-subnet-primary': 'TAOLI 策略1 | 新子网打新',
  rename: 'TAOLI 策略2 | 改名抢跑',
  'coldkey-swap': 'TAOLI 策略3 | 冷键交换'
};

function getStrategyKeys(strategyId, netuid, hotkey) {
  return {
    lockKey: `${strategyId}:${netuid}`,
    successKey: `${strategyId}:${netuid}:${hotkey}`,
    cooldownKey: strategyId === 'new-subnet-primary'
      ? `new-subnet:${netuid}`
      : `${strategyId}:${netuid}`
  };
}

function validateExecutionPlan(plan) {
  if (!plan.strategyId || !Number.isFinite(Number(plan.netuid)) || !plan.hotkey) {
    return 'Invalid strategy execution plan';
  }
  if (plan.priceMode === 'fixed' && (!Number.isFinite(Number(plan.maxPriceLimit)) || Number(plan.maxPriceLimit) <= 0)) {
    return 'Invalid fixed max price';
  }
  return null;
}

async function executeTimeoutRetry({
  wallet,
  strategyId,
  label,
  successKey,
  netuid,
  hotkey,
  attemptNum,
  maxRetries,
  timeoutMs,
  amountTao,
  priceMode,
  slippageLimit = 0,
  maxPriceLimit = 0
}) {
  if (attemptNum > maxRetries) return { success: false, error: 'Max timeout retries reached' };
  if (state.isStrategySuccessful(successKey)) return { success: true };

  // Prevent duplicate concurrent timeout retries for the same wallet
  const key = `${strategyId}:${netuid}:${hotkey}:${wallet.name}`;
  const currentActive = state.activeTimeoutRetryNumByWallet.get(key) || 0;
  if (attemptNum <= currentActive) return { success: false, error: 'Duplicate retry' };
  state.activeTimeoutRetryNumByWallet.set(key, attemptNum);

  if (!wallet.isPrivate) {
    log('WARN', `[${label}] 钱包【${wallet.name}】交易超时。触发第 ${attemptNum}/${maxRetries} 次超时重试...`);
  }

  // Wait 1 second before retrying to ensure the nonce query inside sendTx timeout handler completed
  await new Promise(resolve => setTimeout(resolve, 1000));

  if (state.isStrategySuccessful(successKey)) return { success: true };

  try {
    const amountBigInt = BigInt(Math.floor(amountTao * 1e9));

    const tx = priceMode === 'fixed'
      ? buildFixedLimitStakeTx(hotkey, netuid, amountBigInt, maxPriceLimit)
      : await buildStakeTx(hotkey, netuid, amountBigInt, slippageLimit, maxPriceLimit, null);

    const p = new Promise((resolve) => {
      sendStrategicTx(tx, wallet.pair, timeoutMs, {
        netuid,
        hotkey,
        amountBigInt,
        slippageLimit,
        maxPriceLimit,
        label: `${label}-超时重试#${attemptNum}`,
        isPrivate: wallet.isPrivate
      }).then(res => {
        if (res.success) {
          if (!wallet.isPrivate) {
            log('SUCCESS', `[${label}] 超时重试 #${attemptNum} - 钱包【${wallet.name}】购买成功！交易哈希: ${res.hash}`);
          }
          state.markStrategySuccess(successKey, true);

          if (!wallet.isPrivate) {
            const blockStr = res.blockNumber ? `• <b>成交区块</b>: <code>#${res.blockNumber}</code>\n` : '';
            const idxStr = (res.txIndex !== null && res.txIndex !== undefined) ? `• <b>排队位置</b>: <code>第 ${res.txIndex} 笔交易</code>\n` : '';

            sendTelegramAlert(
              `✅ <b>[${label} 超时重试成功]</b>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `• <b>使用钱包</b>: <code>${escapeHtml(wallet.name)}</code>\n` +
              `• <b>目标子网</b>: <code>SN#${netuid}</code>\n` +
              `• <b>重试次数</b>: <code>${attemptNum}</code>\n` +
              blockStr +
              idxStr +
              `• <b>交易哈希</b>: <code>${res.hash}</code>\n` +
              `━━━━━━━━━━━━━━━━━━`
            );
          }
          resolve(res);
        } else {
          if (!wallet.isPrivate) {
            log('ERROR', `[${label}] 超时重试 #${attemptNum} - 钱包【${wallet.name}】交易失败: ${res.error}`);
          }
          if (res.error && (res.error.includes('timeout') || res.error.includes('Timeout'))) {
            executeTimeoutRetry({
              wallet,
              strategyId,
              label,
              successKey,
              netuid,
              hotkey,
              attemptNum: attemptNum + 1,
              maxRetries,
              timeoutMs,
              amountTao,
              priceMode,
              slippageLimit,
              maxPriceLimit
            }).then(resolve);
          } else {
            resolve(res);
          }
        }
      });
    });

    if (attemptNum === 1) {
      p.finally(() => {
        state.activeTimeoutRetryNumByWallet.delete(key);
      });
    }

    return p;
  } catch (e) {
    if (e.message.includes('Price exceeds limit')) {
      if (!wallet.isPrivate) {
        log('WARN', `⚠️ [${label}] 超时重试已终止：交易价格已超过最高价格限制！`);
      }
      if (attemptNum === 1) {
        state.activeTimeoutRetryNumByWallet.delete(key);
      }
      return { success: false, error: e.message };
    }
    if (!wallet.isPrivate) {
      log('ERROR', `[${label}] 超时重试 #${attemptNum} - 钱包【${wallet.name}】发起异常: ${e.message}`);
    }
    if (attemptNum === 1) {
      state.activeTimeoutRetryNumByWallet.delete(key);
    }
    return { success: false, error: e.message };
  }
}

async function executeStrategy(plan) {
  const {
    strategyId,
    netuid,
    hotkey,
    amountField,
    burstCount,
    retries,
    intervalMs,
    timeoutMs,
    priceMode, 
    slippageLimit, 
    maxPriceLimit, 
    label, 
    timeoutRetries,
    extraParams
  } = plan;

  const validationError = validateExecutionPlan(plan);
  if (validationError === 'Invalid strategy execution plan') {
    throw new Error(validationError);
  }
  if (validationError) {
    log('WARN', `[${label}] 未配置有效固定最高限价，取消执行且不写入冷却。`);
    return { success: false, error: validationError };
  }

  const settings = config.getSettings();
  const activeWallets = state.wallets.filter(w => w.enabled !== false);
  const hasPublicWallet = privateWallet.hasPublic(activeWallets);
  const trace = extraParams?.trace || createTrace();
  const afterBroadcast = extraParams?.afterBroadcast || [];
  const detectedAt = extraParams?.detectedAt || Date.now();

  if (activeWallets.length === 0) {
    if (hasPublicWallet) {
      log('WARN', `[${label}] 触发抢跑，但没有加载启用任何小号钱包！`);
    }
    return;
  }

  // 1. 防重复运行锁
  const { lockKey, successKey, cooldownKey } = getStrategyKeys(strategyId, netuid, hotkey);
  if (state.isStrategyLocked(lockKey)) {
    if (hasPublicWallet) {
      log('INFO', `[${label}] 子网 #${netuid} 抢跑/打新循环已经在运行中，跳过重复触发。`);
    }
    return;
  }

  // 2. 24小时冷却时间校验
  const cooldown = database.getCooldown(cooldownKey);
  let shouldWriteCooldown = false;

  if (cooldown) {
    const elapsed = Date.now() - cooldown.firstTriggeredAt;
    if (elapsed < 24 * 60 * 60 * 1000) {
      if (Math.abs(state.currentBlockHeight - cooldown.block) <= 10) {
        shouldWriteCooldown = false;
      } else {
        if (hasPublicWallet) {
          log('INFO', `[${label}] 检测到子网 #${netuid} 上次触发在 24 小时冷却时间内 (上次区块: #${cooldown.block}, 当前区块: #${state.currentBlockHeight})，且已超过防抖窗口，跳过重复触发。`);
        }
        return;
      }
    } else {
      state.deleteStrategySuccess(successKey);
      shouldWriteCooldown = true;
    }
  } else {
    state.deleteStrategySuccess(successKey);
    shouldWriteCooldown = true;
  }

  // 3. 内存成功状态校验
  if (strategyId !== 'new-subnet-double' && state.isStrategySuccessful(successKey) === true) {
    if (hasPublicWallet) {
      log('INFO', `[${label}] 检测到子网 #${netuid} 之前已抢跑/打新成功，跳过执行。`);
    }
    return;
  }

  // 写入冷却时间
  if (shouldWriteCooldown) {
    const ok = database.setCooldown(cooldownKey, {
      strategy: strategyId.startsWith('new-subnet') ? 'new-subnet' : strategyId,
      netuid: netuid,
      block: state.currentBlockHeight,
      hotkey: hotkey
    });
    if (!ok && hasPublicWallet) {
      log('WARN', `[${label}] 冷却状态写入失败: key = ${cooldownKey}`);
    }
  }

  // 加锁并初始化成功状态
  state.lockStrategy(lockKey);
  if (state.isStrategySuccessful(successKey) === undefined) {
    state.markStrategySuccess(successKey, false);
  }

  if (hasPublicWallet) {
    traceLog(trace, 'INFO', `[${label}] 启动抢跑/打新机制 -> 目标子网 #${netuid}, 目标 Hotkey: ${hotkey}, 单轮并发数: ${burstCount}, 最大扫射轮数: ${retries}轮, 扫射间隔: ${intervalMs}ms`);

    const amountTao = settings[amountField] || 0;
    if (strategyId.startsWith('new-subnet')) {
      if (strategyId === 'new-subnet-primary') {
        afterBroadcast.push(() => {
          sendFlashDutyAlert(
            `${FLASH_DUTY_STRATEGY_TITLES[strategyId]} | SN${netuid}`,
            `触发源: ${extraParams?.triggerSource || 'startCall'}\n目标子网: SN#${netuid}\n目标 Hotkey: ${hotkey}\n策略通道: 主线打新\n打新金额: ${amountTao} TAO`,
            settings
          ).catch(() => {});
        });
      }
      afterBroadcast.push(() => {
        sendTelegramAlert(`🚀 [${label} 极速启动]\n子网: #${netuid}\n目标 Hotkey: ${hotkey}\n固定最高限价: ${maxPriceLimit} TAO/Alpha\n单轮并发数: ${burstCount}\n最大扫射轮数: ${retries}轮\n扫射间隔: ${intervalMs}ms`).catch(() => {});
      });
    } else {
      afterBroadcast.push(() => {
        sendFlashDutyAlert(
          `${FLASH_DUTY_STRATEGY_TITLES[strategyId]} | SN${netuid}`,
          `目标子网: SN#${netuid}\n目标 Hotkey: ${hotkey}\n策略: ${label}\n抢跑金额: ${amountTao} TAO`,
          settings
        ).catch(() => {});
      });
    }
  }

  const txPromises = [];

  try {
    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt > 0 && state.isStrategySuccessful(successKey)) {
        if (hasPublicWallet) {
          log('INFO', `[${label}] 检测到已有并发购买交易成功上链，自动终止后续的第 ${attempt + 1}/${retries} 轮扫射。`);
        }
        break;
      }

      if (hasPublicWallet) {
        traceLog(trace, 'INFO', `[${label}] 开始执行第 ${attempt + 1}/${retries} 轮扫射尝试...`);
      }

      for (const w of activeWallets) {
        const wAmountTao = w[amountField] !== undefined ? w[amountField] : settings[amountField];
        const wAmountBigInt = BigInt(Math.floor(wAmountTao * 1e9));

        for (let i = 0; i < burstCount; i++) {
          try {
            let tx;
            if (priceMode === 'fixed') {
              tx = buildFixedLimitStakeTx(hotkey, netuid, wAmountBigInt, maxPriceLimit);
            } else {
              tx = await buildStakeTx(hotkey, netuid, wAmountBigInt, slippageLimit);
            }

            if (!w.isPrivate) {
              traceLog(trace, 'INFO', `[${label}] 轮次 ${attempt + 1} - 钱包【${w.name}】并发第 ${i + 1}/${burstCount} 笔购买交易发起...`);
            }

            const p = sendStrategicTx(tx, w.pair, timeoutMs, {
              netuid,
              hotkey,
              amountBigInt: wAmountBigInt,
              slippageLimit: priceMode === 'slippage' ? slippageLimit : undefined,
              maxPriceLimit: priceMode === 'fixed' ? maxPriceLimit : undefined,
              label: `${label}-轮次${attempt + 1}-并发#${i + 1}`,
              detectedAt,
              trace,
              afterBroadcast,
              isPrivate: w.isPrivate
            }).then(res => {
              if (res.success) {
                if (!w.isPrivate) {
                  log('SUCCESS', `[${label} 成功] 轮次 ${attempt + 1} - 钱包【${w.name}】并发第 ${i + 1} 笔购买成功！交易哈希: ${res.hash}`);
                  state.markStrategySuccess(successKey, true);

                  const blockStr = res.blockNumber ? `• <b>成交区块</b>: <code>#${res.blockNumber}</code>\n` : '';
                  const idxStr = (res.txIndex !== null && res.txIndex !== undefined) ? `• <b>排队位置</b>: <code>第 ${res.txIndex} 笔交易</code>\n` : '';

                  sendTelegramAlert(
                    `✅ <b>[${label} 成功]</b>\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `• <b>使用钱包</b>: <code>${escapeHtml(w.name)}</code>\n` +
                    `• <b>目标子网</b>: <code>SN#${netuid}</code>\n` +
                    blockStr +
                    idxStr +
                    `• <b>交易哈希</b>: <code>${res.hash}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━`
                  );
                } else {
                  state.markStrategySuccess(successKey, true);
                }
                return { ...res, isPrivate: w.isPrivate };
              } else {
                if (!w.isPrivate) {
                  log('ERROR', `[${label} 失败] 轮次 ${attempt + 1} - 钱包【${w.name}】并发第 ${i + 1} 笔交易失败: ${res.error}`);
                }

                // 超时重试判定
                if (res.error && (res.error.includes('timeout') || res.error.includes('Timeout')) && timeoutRetries > 0) {
                  return executeTimeoutRetry({
                    wallet: w,
                    strategyId,
                    label,
                    successKey,
                    netuid,
                    hotkey,
                    attemptNum: 1,
                    maxRetries: timeoutRetries,
                    timeoutMs,
                    amountTao: wAmountTao,
                    priceMode,
                    slippageLimit,
                    maxPriceLimit
                  })
                    .then(retryRes => ({ ...retryRes, isPrivate: w.isPrivate }));
                }
                return { ...res, isPrivate: w.isPrivate };
              }
            });
            txPromises.push(p);
          } catch (e) {
            if (!w.isPrivate) {
              log('ERROR', `[${label}] 轮次 ${attempt + 1} - 钱包【${w.name}】并发第 ${i + 1} 笔交易抛出异常: ${e.message}`);
            }
          }
        }
      }

      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
  } finally {
    const unlock = () => {
      state.unlockStrategy(lockKey);
    };

    if (txPromises.length > 0) {
      Promise.allSettled(txPromises).then((results) => {
        const anySuccess = state.isStrategySuccessful(successKey);
        if (!anySuccess && strategyId.startsWith('new-subnet')) {
          const errorMsgs = results
            .map(r => {
              if (r.status === 'fulfilled') {
                const val = r.value;
                if (val && !val.isPrivate) {
                  return val.error;
                }
              } else {
                return r.reason?.message;
              }
              return null;
            })
            .filter(Boolean);
          const uniqueErrors = [...new Set(errorMsgs)].slice(0, 3).join('; ');

          if (hasPublicWallet) {
            const msg = `❌ [${label} 失败]\n子网: #${netuid}\n目标 Hotkey: ${hotkey}\n原因: ${escapeHtml(uniqueErrors || '所有交易提交超时或未成功上链')}`;
            log('ERROR', msg);
            sendTelegramAlert(msg).catch(() => {});
          }
        }
      }).finally(unlock);
      setTimeout(unlock, 180000);
    } else {
      setTimeout(unlock, Math.max(3000, intervalMs));

      if (hasPublicWallet && strategyId.startsWith('new-subnet')) {
        const msg = `❌ [${label} 失败]\n子网: #${netuid}\n目标 Hotkey: ${hotkey}\n原因: 未能构建或发送任何交易`;
        log('ERROR', msg);
        sendTelegramAlert(msg).catch(() => {});
      }
    }
  }
}

module.exports = {
  executeStrategy,
  getStrategyKeys,
  validateExecutionPlan
};
