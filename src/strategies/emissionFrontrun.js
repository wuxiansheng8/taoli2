const state = require('../state');
const config = require('../config');
const { log } = require('../logger');
const subnetCache = require('../chain/subnetCache');
const transactionService = require('../transaction/transactionService');
const { sendTelegramAlert, sendFlashDutyAlert, escapeHtml } = require('../notifier');

function notifySuccessOnce(run, walletName, txResult, settings) {
  if (run.alerted) return;
  run.alerted = true;

  const blockLine = txResult.blockNumber
    ? `• <b>成交区块</b>: <code>#${txResult.blockNumber}</code>\n`
    : '';
  const indexLine = txResult.txIndex !== null && txResult.txIndex !== undefined
    ? `• <b>排队位置</b>: <code>第 ${txResult.txIndex} 笔交易</code>\n`
    : '';
  const message =
    `✅ <b>[策略4 TAO侧排放抢跑成功]</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `• <b>目标子网</b>: <code>SN#${run.netuid}</code>\n` +
    `• <b>成功钱包</b>: <code>${escapeHtml(walletName)}</code>\n` +
    `• <b>触发来源</b>: <code>${run.source}</code>\n` +
    blockLine +
    indexLine +
    `• <b>交易哈希</b>: <code>${txResult.hash}</code>\n` +
    `━━━━━━━━━━━━━━━━━━`;

  sendTelegramAlert(message).catch(() => {});
  sendFlashDutyAlert(
    `TAOLI 策略4抢跑成功 - 子网 #${run.netuid}`,
    `钱包 ${walletName} 已在子网 #${run.netuid} 成功提交 TAO 质押。交易哈希: ${txResult.hash}`,
    settings
  ).catch(() => {});
  log('SUCCESS', `[策略4/成功] 来源: ${run.source} | 子网: #${run.netuid} | 钱包【${walletName}】| 成交区块: #${txResult.blockNumber || '未知'} | 位置: ${txResult.txIndex ?? '未知'} | 总耗时: ${Date.now() - run.detectedAt}ms | 哈希: ${txResult.hash}`);
}

async function executeRun(run, wallets, hotkey, settings) {
  try {
    const currentPrice = await subnetCache.getSubnetPrice(run.netuid);
    if (currentPrice === null) {
      throw new Error(`无法获取子网 #${run.netuid} 当前价格，已拒绝发单`);
    }

    const retries = Math.min(100, Math.max(1, Number(settings.emissionRetries) || 1));
    const burstCount = Math.min(10, Math.max(1, Number(settings.emissionBurstCount) || 1));
    const intervalMs = Math.max(1, Number(settings.emissionIntervalMs) || 1000);
    const timeoutMs = Math.max(1000, Number(settings.emissionTimeoutMs) || 30000);
    const txPromises = [];

    if (run.publicWalletCount > 0) {
      log('INFO', `[策略4/执行] 来源: ${run.source} | 子网: #${run.netuid} | 目标 Hotkey: ${hotkey} | 当前价格: ${(Number(currentPrice) / 1e9).toFixed(6)} TAO/Alpha | 普通钱包数: ${run.publicWalletCount} | 单轮并发: ${burstCount} | 最大轮数: ${retries} | 间隔: ${intervalMs}ms`);
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt > 0 && run.status === 'success') break;

      for (const wallet of wallets) {
        const amountTao = wallet.emissionAmount !== undefined
          ? Number(wallet.emissionAmount)
          : Number(settings.emissionAmount);
        if (!Number.isFinite(amountTao) || amountTao <= 0) {
          if (!wallet.isPrivate) {
            log('WARN', `[策略4] 钱包【${wallet.name}】未配置有效抢跑金额，已跳过。`);
          }
          continue;
        }

        const amountBigInt = BigInt(Math.floor(amountTao * 1e9));
        for (let burst = 0; burst < burstCount; burst++) {
          try {
            if (!wallet.isPrivate) {
              log('INFO', `[策略4/发送] 来源: ${run.source} | 子网: #${run.netuid} | 钱包【${wallet.name}】| 金额: ${amountTao} TAO | 轮次: ${attempt + 1}/${retries} | 并发: ${burst + 1}/${burstCount} | 距触发: ${Date.now() - run.detectedAt}ms`);
            }
            const tx = transactionService.buildCachedSlippageStakeTx(
              hotkey,
              run.netuid,
              amountBigInt,
              currentPrice,
              settings.emissionSlippageLimit
            );
            const txPromise = transactionService.sendStrategicTx(tx, wallet.pair, timeoutMs, {
              netuid: run.netuid,
              hotkey,
              amountBigInt,
              label: `排放开启抢跑-轮次${attempt + 1}-并发#${burst + 1}`,
              detectedAt: run.detectedAt,
              isPrivate: wallet.isPrivate,
              fastSign: true
            }).then(result => {
              if (result.success) {
                run.status = 'success';
                if (!wallet.isPrivate) {
                  notifySuccessOnce(run, wallet.name, result, settings);
                }
              } else if (!wallet.isPrivate) {
                log('ERROR', `[策略4/失败] 来源: ${run.source} | 子网: #${run.netuid} | 钱包【${wallet.name}】| 轮次: ${attempt + 1}/${retries} | 并发: ${burst + 1}/${burstCount} | 原因: ${result.error}`);
              }
              return result;
            });
            txPromises.push(txPromise);
          } catch (error) {
            if (!wallet.isPrivate) {
              log('ERROR', `[策略4] 钱包【${wallet.name}】构造交易失败: ${error.message}`);
            }
          }
        }
      }

      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    const results = await Promise.allSettled(txPromises);
    if (run.status !== 'success') {
      run.status = results.some(result => result.status === 'fulfilled' && result.value.success)
        ? 'success'
        : 'failed';
    }
  } catch (error) {
    run.status = 'failed';
    log('ERROR', `[策略4] 子网 #${run.netuid} 执行异常: ${error.message}`);
  }
}

function trigger({ netuid, source, triggerId, triggerBlock = null, callPath = null }) {
  const settings = config.getSettings();
  if (!settings.emissionEnabled) {
    return false;
  }

  const slippage = Number(settings.emissionSlippageLimit);
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 1) {
    log('WARN', '[策略4] 最大滑点必须大于 0 且不超过 1，已拒绝发单。');
    return false;
  }

  const hotkey = subnetCache.resolveHotkey(netuid);
  if (!hotkey) {
    log('WARN', `[策略4] 子网 #${netuid} 没有可用目标 Hotkey，已拒绝发单。`);
    return false;
  }

  const wallets = state.wallets.filter(wallet => wallet.enabled !== false && wallet.pair);
  if (wallets.length === 0) {
    log('WARN', '[策略4] 没有启用的钱包，已拒绝发单。');
    return false;
  }

  const existing = state.emissionRuns.get(netuid);
  if (existing) {
    const canRetry = existing.status === 'failed' && existing.triggerId !== triggerId;
    if (!canRetry) return false;
  }

  const run = {
    netuid,
    source,
    triggerId,
    triggerBlock,
    callPath,
    detectedAt: Date.now(),
    status: 'running',
    alerted: false,
    publicWalletCount: wallets.filter(wallet => !wallet.isPrivate).length
  };

  if (run.publicWalletCount > 0) {
    const detail = triggerBlock
      ? `确认区块: #${triggerBlock}`
      : `原始交易: ${triggerId}${callPath ? ` | 调用路径: ${callPath}` : ''}`;
    const channel = source.startsWith('Mempool') ? 'Pending' : '区块兜底';
    log('INFO', `[策略4/${channel}] 检测到子网 #${netuid} 开启排放 | ${detail}`);
  }
  state.emissionRuns.set(netuid, run);
  executeRun(run, wallets, hotkey, settings);
  return true;
}

module.exports = {
  trigger
};
