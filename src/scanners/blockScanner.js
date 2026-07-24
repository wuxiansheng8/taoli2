const state = require('../state');
const config = require('../config');
const { log, createTrace, traceLog } = require('../logger');
const { sendTelegramAlert, escapeHtml } = require('../notifier');
const subnetCache = require('../chain/subnetCache');
const { extractSubtensorCalls, getCallKey, decodeSubtensorEvent } = require('../chain/parser');
const router = require('../strategies/router');
const subtensorClient = require('../chain/subtensorClient');
const privateWallet = require('../privateWallet');
const emissionWatcher = require('../strategies/emissionWatcher');
const emissionFrontrun = require('../strategies/emissionFrontrun');

const EVENT_QUERY_RETRY_DELAY_MS = 200;

class BlockScanner {
  constructor() {
    this._unsubscribeHeads = null;
  }

  async start() {
    if (!subtensorClient.isConnected()) return;

    if (this._unsubscribeHeads) {
      try { this._unsubscribeHeads(); } catch (e) {}
      this._unsubscribeHeads = null;
    }

    const generation = state.connectGeneration;

    try {
      this._unsubscribeHeads = await subtensorClient.subscribeNewHeads(async (header) => {
        if (generation !== state.connectGeneration || state.botStatus !== 'Running') return;
        const blockNumber = header.number.toNumber();
        state.currentBlockHeight = blockNumber;
        state.cachedBlockHash = header.hash;

        if (global.blockCallback) {
          global.blockCallback(blockNumber);
        }

        // 交易自愈与漏扫检测
        this.detectEventsInBlock(header.hash, blockNumber).catch(e => {
          log('WARN', `[区块兜底] 解析新区块 #${blockNumber} 失败: ${e.message}`);
        });

        const derived = config.getDerivedConfig();
        if (derived.dashingActive) {
          const runDashingFlow = async () => {
            const hasChange = await this.detectNewSubnetOnChain(state.currentBlockHeight);
            if (hasChange || state.currentBlockHeight % 100 === 0) {
              await subnetCache.refreshSubnetOwnersCache();
            }
          };
          runDashingFlow().catch(e => {
            log('WARN', `[新子网打新] 链上自愈检测/缓存同步失败: ${e.message}`);
          });
        } else {
          if (state.currentBlockHeight % 100 === 0) {
            subnetCache.refreshSubnetOwnersCache().catch(() => {});
          }
        }
      });
    } catch (err) {
      log('ERROR', `订阅区块头事件失败: ${err.message}`);
    }
  }

  stop() {
    if (this._unsubscribeHeads) {
      try { this._unsubscribeHeads(); } catch (e) {}
      this._unsubscribeHeads = null;
    }
  }

  async getBlockEvents(blockHash, blockNumber) {
    try {
      return await subtensorClient.querySystemEventsAt(blockHash);
    } catch {
      await new Promise(resolve => setTimeout(resolve, EVENT_QUERY_RETRY_DELAY_MS));

      try {
        return await subtensorClient.querySystemEventsAt(blockHash);
      } catch (error) {
        log('WARN', `[区块事件] 读取区块 #${blockNumber} 事件失败，重试后仍未成功: ${error.message}`);
        return [];
      }
    }
  }

  async detectEventsInBlock(blockHash, blockNumber) {
    const settings = config.getSettings();
    const doubleStakingDelay = Number(settings.dashingDoubleStakingDelay || 0);
    const dashingActive = settings.dashingEnabled || doubleStakingDelay > 0;
    if (!settings.renameEnabled && !settings.swapEnabled && !dashingActive && !emissionWatcher.isEnabled()) return;

    if (settings.swapEnabled && subnetCache.getCacheSize() === 0) {
      await subnetCache.refreshSubnetOwnersCache();
    }

    const now = Date.now();
    const afterBlockFallback = [];
    const flushAfterBlockFallback = () => {
      for (const fn of afterBlockFallback) {
        const timer = setTimeout(fn, 1000);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }
    };

    const allRecords = await this.getBlockEvents(blockHash, blockNumber);

    if (allRecords && allRecords.length > 0) {
      for (const record of allRecords) {
        const { event, phase } = record;
        if (!phase.isApplyExtrinsic) continue;
        const extrinsicIndex = phase.asApplyExtrinsic.toNumber();

        const decoded = decodeSubtensorEvent(event, blockNumber, extrinsicIndex);
        if (decoded.type === 'UNKNOWN') continue;

        emissionWatcher.handleBlockEvent(decoded, blockNumber);

        // 1. NetworkAdded
        if (decoded.type === 'NETWORK_ADDED') {
          const netuid = decoded.netuid;
          const logMsg = `[新子网打新] 目标子网 #${netuid} 已于区块 #${blockNumber} 第 ${extrinsicIndex} 笔交易正式注册成功！`;
          afterBlockFallback.push(() => {
            log('SUCCESS', logMsg);
            sendTelegramAlert(
              `🎉 <b>[新子网打新 链上注册成功]</b>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `• <b>注册子网</b>: <code>SN#${netuid}</code>\n` +
              `• <b>成交区块</b>: <code>#${blockNumber}</code>\n` +
              `• <b>排队位置</b>: <code>第 ${extrinsicIndex} 笔交易</code>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `<i>🎉 子网已被链正式确认添加！</i>`
            ).catch(() => {});
          });
        }

        // 2. SubnetIdentitySet
        else if (decoded.type === 'SUBNET_IDENTITY_SET') {
          const netuid = decoded.netuid;
          const logMsg = `[改名抢跑] 目标子网 #${netuid} 已于区块 #${blockNumber} 第 ${extrinsicIndex} 笔交易正式改名成功！`;
          afterBlockFallback.push(() => {
            log('SUCCESS', logMsg);
            sendTelegramAlert(
              `🎉 <b>[改名抢跑 链上改名成功]</b>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `• <b>改名子网</b>: <code>SN#${netuid}</code>\n` +
              `• <b>成交区块</b>: <code>#${blockNumber}</code>\n` +
              `• <b>排队位置</b>: <code>第 ${extrinsicIndex} 笔交易</code>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `<i>🎉 目标子网改名已由链正式确认！</i>`
            ).catch(() => {});
          });
        }

        // 3. ColdkeySwapAnnounced
        else if (decoded.type === 'COLDKEY_SWAP_ANNOUNCED') {
          const coldkey = decoded.coldkey;
          const swapColdkeyHash = decoded.swapColdkeyHash;

          if (settings.swapEnabled && subnetCache.isSubnetOwnerAddress(coldkey)) {
            const logMsg = `[冷键交换声明成功] 钱包 ${coldkey} 已于区块 #${blockNumber} 第 ${extrinsicIndex} 笔交易正式发起冷键交换声明 -> ${swapColdkeyHash}！`;
            const hasPublic = privateWallet.hasPublic(state.wallets.filter(w => w.enabled !== false));
            const coldkeyAnnouncedMsg =
              `🎉 <b>[冷键交换 链上发起成功]</b>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `• <b>声明钱包</b>: <code>${coldkey}</code>\n` +
              `• <b>成交区块</b>: <code>#${blockNumber}</code>\n` +
              `• <b>排队位置</b>: <code>第 ${extrinsicIndex} 笔交易</code>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `<i>🎉 冷键交换声明已由链正式确认！</i>`;

            let triggerTrace = null;
            let triggerAfterBroadcast = null;
            if (hasPublic) {
              triggerTrace = createTrace();
              triggerAfterBroadcast = [];
              traceLog(triggerTrace, 'SUCCESS', logMsg);
              triggerAfterBroadcast.push(() => sendTelegramAlert(coldkeyAnnouncedMsg).catch(() => {}));
            }

            const mockParsed = {
              callName: 'announce_coldkey_swap',
              signer: coldkey,
              nonce: 0,
              args: {}
            };

            router.handlePendingExtrinsic(mockParsed, 'Block-Fallback', blockNumber, {
              trace: triggerTrace,
              afterBroadcast: triggerAfterBroadcast
            });
          }
        }

        // 4. FirstEmissionBlockNumberSet
        else if (decoded.type === 'FIRST_EMISSION_BLOCK_SET') {
          const netuid = decoded.netuid;
          const blockNumVal = decoded.activationBlock;
          const actionKey = `startCallConfirmed:${blockNumber}:${netuid}`;
          if (!state.hasAction(actionKey)) {
            state.markAction(actionKey, now);
            const logMsg = `🎉 [新子网打新] 目标子网 #${netuid} 的 startCall 激活事件已于区块 #${blockNumber} 第 ${extrinsicIndex} 笔交易被正式确认（激活区块: #${blockNumVal}）！`;
            log('SUCCESS', logMsg);
            sendTelegramAlert(
              `🎉 <b>[新子网打新 链上激活成功]</b>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `• <b>激活子网</b>: <code>SN#${netuid}</code>\n` +
              `• <b>生效区块</b>: <code>#${blockNumVal}</code>\n` +
              `• <b>排队位置</b>: <code>第 ${extrinsicIndex} 笔交易</code>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `<i>🎉 目标子网已被所有者正式激活！</i>`
            ).catch(() => {});

            const mainTriggerKey = `startCall:${netuid}`;
            if (!state.hasAction(mainTriggerKey) && settings.dashingEnabled) {
              const expectedOwner = subnetCache.getOwner(netuid) || 'unknown';
              const mockParsed = {
                callName: 'start_call',
                args: { netuid },
                signer: expectedOwner,
                nonce: 0
              };
              router.handlePendingExtrinsic(mockParsed, 'Block-Fallback-startCall', blockNumber).catch(e => {
                log('ERROR', `[新子网打新] 事件层自愈激活处理失败: ${e.message}`);
              });
            }
          }
        }

        // 5. StakeAdded
        else if (decoded.type === 'STAKE_ADDED') {
          const coldkey = decoded.coldkey;
          const hotkey = decoded.hotkey;
          const amountTao = decoded.amountTao.toFixed(2);
          const netuid = decoded.netuid;

          const confirmedByEmissionStrategy = emissionFrontrun.confirmStakeAdded({
            netuid,
            coldkey,
            hotkey,
            blockNumber,
            txIndex: extrinsicIndex
          });
          if (confirmedByEmissionStrategy) continue;

          const w = state.wallets.find(x => x.pair && x.pair.address === coldkey);
          if (w) {
            if (!w.isPrivate) {
              const logMsg = `[打新/抢跑成功] 我们的钱包【${w.name}】已于区块 #${blockNumber} 第 ${extrinsicIndex} 笔交易成功在子网 #${netuid} 质押！金额: ${amountTao} TAO (Hotkey: ${hotkey})`;

              let strategyLabel = '新子网打新';
              const nowTime = Date.now();
              for (const [key, ts] of state.getActions()) {
                if (nowTime - ts < 5 * 60 * 1000) {
                  if (key.startsWith(`swap:${netuid}:`)) {
                    strategyLabel = '冷键交换抢跑';
                    break;
                  } else if (key.startsWith(`rename:${netuid}:`)) {
                    strategyLabel = '改名抢跑';
                    break;
                  }
                }
              }

              afterBlockFallback.push(() => {
                log('SUCCESS', logMsg);
                sendTelegramAlert(
                  `🔔 <b>[${strategyLabel} 链上最终确认]</b>\n` +
                  `━━━━━━━━━━━━━━━━━━\n` +
                  `• <b>我方钱包</b>: <code>${escapeHtml(w.name)}</code>\n` +
                  `• <b>成交区块</b>: <code>#${blockNumber}</code>\n` +
                  `• <b>排队位置</b>: <code>第 ${extrinsicIndex} 笔交易</code>\n` +
                  `• <b>最终质押</b>: <code>${amountTao} TAO</code>\n` +
                  `• <b>目标子网</b>: <code>SN#${netuid}</code>\n` +
                  `• <b>目标Hotkey</b>: <code>${hotkey}</code>\n` +
                  `━━━━━━━━━━━━━━━━━━\n` +
                  `<i>🎉 资金已最终确认上链！</i>`
                ).catch(() => {});
              });
            }
          }
        }
      }
    }

    // 扫描链上交易 (区块兜底)
    try {
      const block = await subtensorClient.getBlock(blockHash);
      const extrinsics = block?.block?.extrinsics;
      if (!extrinsics || extrinsics.length === 0) {
        flushAfterBlockFallback();
        return;
      }

      for (let extIndex = 0; extIndex < extrinsics.length; extIndex++) {
        const ext = extrinsics[extIndex];
        if (!ext || !ext.method) continue;

        try {
          const actions = extractSubtensorCalls(ext);
          for (const parsed of actions) {
            const sec = parsed.section;
            const meth = parsed.callName;

            const isRename = settings.renameEnabled &&
              /^subtensor(Module)?$/i.test(sec) &&
              /^(setSubnetIdentity|set_subnet_identity)$/i.test(meth);

            const isStartCall = dashingActive &&
              /^subtensor(Module)?$/i.test(sec) &&
              /^(startCall|start_call)$/i.test(meth);

            if (!isRename && !isStartCall) continue;

            const callKey = getCallKey(parsed);
            const entry = state.getHash(callKey);
            if (entry && entry.handled) continue;

            if (isRename) {
              const triggerTrace = createTrace();
              const triggerAfterBroadcast = [];
              traceLog(triggerTrace, 'INFO', `[区块兜底] 在区块 #${blockNumber} 中补扫到漏掉的改名交易 (Hash: ${parsed.txHash})`);
              const handled = await router.handlePendingExtrinsic(parsed, 'Block-Fallback', blockNumber, {
                trace: triggerTrace,
                afterBroadcast: triggerAfterBroadcast
              });
              state.markHash(callKey, {
                timestamp: now,
                netuid: null,
                tipTao: parsed.tipTao,
                isRegisterNetwork: false,
                handled: !!handled
              });
            } else if (isStartCall) {
              const netuid = Number(parsed.args.netuid?.toString() || parsed.args[0]?.toString());
              const triggerTrace = createTrace();
              const triggerAfterBroadcast = [];
              if (Number.isFinite(netuid) && netuid > 0) {
                const actionKey = `startCallConfirmed:${blockNumber}:${netuid}`;
                if (!state.hasAction(actionKey)) {
                  state.markAction(actionKey, now);
                  log('INFO', `[区块兜底] 扫到子网 #${netuid} 的 startCall 交易，正在执行自愈判定...`);
                }
              }
              const handled = await router.handlePendingExtrinsic(parsed, 'Block-Fallback', blockNumber, {
                trace: triggerTrace,
                afterBroadcast: triggerAfterBroadcast
              });
              state.markHash(callKey, {
                timestamp: now,
                netuid: null,
                tipTao: parsed.tipTao,
                isRegisterNetwork: false,
                handled: !!handled
              });
            }
          }
        } catch (err) {
          // Extrinsic parse fail
        }
      }
    } catch (err) {
      // Get block fail
    }

    flushAfterBlockFallback();
  }

  async detectNewSubnetOnChain(blockHeight) {
    if (!subtensorClient.isConnected()) return false;
    try {
      let detected = false;
      const cachedNetuids = subnetCache.getRegisteredNetuids();
      const netuidsToQuery = cachedNetuids.length > 0
        ? [...cachedNetuids]
        : Array.from({ length: 33 }, (_, i) => i);

      const maxCached = cachedNetuids.length > 0 ? Math.max(...cachedNetuids) : -1;
      if (maxCached >= 0 && maxCached < 256) {
        netuidsToQuery.push(maxCached + 1);
      }

      const registeredBlocks = await subtensorClient.queryNetworkRegisteredAtMulti(netuidsToQuery);

      for (let i = 0; i < netuidsToQuery.length; i++) {
        const netuid = netuidsToQuery[i];
        const regBlockVal = registeredBlocks[i];
        if (!regBlockVal || regBlockVal.isEmpty) continue;

        const regBlock = Number(regBlockVal.toString());
        if (regBlock === 0) continue;

        const cachedRegBlock = subnetCache.getRegisteredBlock(netuid);

        if (regBlock === blockHeight && (!cachedRegBlock || cachedRegBlock < regBlock)) {
          subnetCache.setRegisteredBlock(netuid, regBlock);

          const alertMsg = `🔔 <b>[区块确认 - 新子网已上链]</b>\n` +
                           `━━━━━━━━━━━━━━━━━━\n` +
                           `• <b>发现子网</b>: <code>SN#${netuid}</code>\n` +
                           `• <b>成交区块</b>: <code>#${blockHeight}</code>\n` +
                           `━━━━━━━━━━━━━━━━━━\n` +
                           `<i>⚠️ 交易池未扫到该注册，已通过区块扫描自愈！正在监听该子网的 startCall 以备抢跑！</i>`;
          log('SUCCESS', `[区块确认 - 新子网已上链] 检测到新子网已在区块 #${blockHeight} 确认注册！新子网为: SN#${netuid}`);
          sendTelegramAlert(alertMsg).catch(() => {});
          detected = true;
        }
      }
      return detected;
    } catch (e) {
      log('ERROR', `[新子网打新] 链上自愈检测发生异常: ${e.message}`);
      return false;
    }
  }
}

module.exports = new BlockScanner();
