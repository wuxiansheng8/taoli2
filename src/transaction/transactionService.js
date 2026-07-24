const state = require('../state');
const config = require('../config');
const { log, flushTrace } = require('../logger');
const walletService = require('../wallet/walletService');
const subtensorClient = require('../chain/subtensorClient');
const subnetCache = require('../chain/subnetCache');

function toLimitPricePlanck(maxPriceLimit) {
  const limit = Number(maxPriceLimit || 0);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('Strategy 1 fixed max price must be greater than 0');
  }
  return BigInt(Math.floor(limit * 1e9));
}

function buildFixedLimitStakeTx(hotkey, netuid, amountBigInt, maxPriceLimit, allowPartial = null) {
  if (!subtensorClient.isConnected() || !subtensorClient.hasAddStakeLimit()) {
    throw new Error('Current node/runtime does not support addStakeLimit');
  }
  const effectiveAllowPartial = allowPartial === null
    ? config.getSettings().allowPartialStaking !== false
    : allowPartial;
  return subtensorClient.buildAddStakeLimitTx(
    hotkey,
    netuid,
    amountBigInt,
    toLimitPricePlanck(maxPriceLimit),
    effectiveAllowPartial
  );
}

function buildCachedSlippageStakeTx(hotkey, netuid, amountBigInt, currentPrice, slippageLimit) {
  if (!subtensorClient.isConnected() || !subtensorClient.hasAddStakeLimit()) {
    throw new Error('Current node/runtime does not support addStakeLimit');
  }

  const price = BigInt(currentPrice);
  const slippage = Number(slippageLimit);
  if (price <= 0n) {
    throw new Error('Current subnet price must be greater than 0');
  }
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 1) {
    throw new Error('Slippage limit must be greater than 0 and no more than 1');
  }

  const slippageParts = BigInt(Math.floor(slippage * 1_000_000));
  const limitPrice = price + ((price * slippageParts) / 1_000_000n);
  const allowPartial = config.getSettings().allowPartialStaking !== false;
  return subtensorClient.buildAddStakeLimitTx(
    hotkey,
    netuid,
    amountBigInt,
    limitPrice,
    allowPartial
  );
}

async function buildStakeTx(hotkey, netuid, amountBigInt, slippageLimit, maxPriceLimit = 0, passedPrice = null) {
  const hasLimitCall = subtensorClient.hasAddStakeLimit();
  const hasLimitProtection = (slippageLimit !== undefined && slippageLimit !== null && slippageLimit > 0) ||
                            (maxPriceLimit !== undefined && maxPriceLimit !== null && maxPriceLimit > 0);

  if (hasLimitProtection) {
    if (hasLimitCall) {
      let currentPrice = passedPrice;
      if (currentPrice === null) {
        currentPrice = await subnetCache.getSubnetPrice(netuid);
      }

      if (currentPrice !== null) {
        const settings = config.getSettings();
        const priceInTao = Number(currentPrice) / 1e9;

        // 二次保底校验最高价格限价
        if (maxPriceLimit > 0 && priceInTao > maxPriceLimit) {
          throw new Error(`Price exceeds limit: current ${priceInTao.toFixed(4)} TAO/Alpha, limit ${maxPriceLimit.toFixed(4)} TAO/Alpha`);
        }

        let limitPrice;
        if (slippageLimit > 0 && maxPriceLimit > 0) {
          const slippageMultiplier = 1.0 + parseFloat(slippageLimit);
          const slipLimitBig = BigInt(Math.floor(Number(currentPrice) * slippageMultiplier));
          const maxLimitBig = BigInt(Math.floor(maxPriceLimit * 1e9));
          limitPrice = slipLimitBig < maxLimitBig ? slipLimitBig : maxLimitBig;
        } else if (slippageLimit > 0) {
          const slippageMultiplier = 1.0 + parseFloat(slippageLimit);
          limitPrice = BigInt(Math.floor(Number(currentPrice) * slippageMultiplier));
        } else {
          limitPrice = BigInt(Math.floor(maxPriceLimit * 1e9));
        }

        const allowPartial = settings.allowPartialStaking !== false;
        return subtensorClient.buildAddStakeLimitTx(hotkey, netuid, amountBigInt, limitPrice, allowPartial);
      } else {
        log('WARN', `⚠️ [限价保护] 未能获取到子网 #${netuid} 的当前价格，限价保护失效！已自动降级为市价质押（普通 addStake 交易），以优先保证打新速度。`);
      }
    } else {
      log('WARN', `⚠️ [限价保护] 链上节点不支持限价质押方法，已自动降级为市价质押（普通 addStake 交易）。`);
    }
  }
  return subtensorClient.buildAddStakeTx(hotkey, netuid, amountBigInt);
}

async function sendTx(tx, pair, txTimeoutMs = 15000, nonce = null, meta = null) {
  return new Promise(async (resolve) => {
    let unsubscribe = null;
    let settled = false;
    const address = pair.address;
    const startTime = Date.now();

    const reservedNonce = nonce !== null ? nonce : walletService.reserveNonce(address);
    if (reservedNonce === null) {
      if (!meta || !meta.isPrivate) {
        log('ERROR', `❌ [交易终止] 钱包【${address.slice(-6)}】本地 Nonce 未就绪，中止发送交易！`);
      }
      return resolve({ success: false, error: 'Local nonce not ready' });
    }

    const options = {};
    options.nonce = reservedNonce;

    // 统一设置交易为 Mortal Era
    if (state.cachedBlockHash && state.currentBlockHeight > 0) {
      options.blockHash = state.cachedBlockHash;
      options.era = { period: 8, current: state.currentBlockHeight };
    } else {
      options.era = 0;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      walletService.releaseNonce(address, reservedNonce);
      clearTimeout(timeout);
      if (typeof unsubscribe === 'function') unsubscribe();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      walletService.refreshNonceForwardOnly(address);
      finish({ success: false, error: 'Transaction timeout' });
    }, txTimeoutMs);

    try {
      const signStartTime = Date.now();
      if (meta?.fastSign) {
        if (!state.api || !state.cachedBlockHash || state.currentBlockHeight <= 0) {
          throw new Error('Fast signing context is not ready');
        }
        tx.sign(pair, {
          nonce: reservedNonce,
          blockHash: state.cachedBlockHash,
          era: state.api.registry.createType('ExtrinsicEra', {
            period: 8,
            current: state.currentBlockHeight
          }),
          genesisHash: state.api.genesisHash,
          runtimeVersion: state.api.runtimeVersion,
          signedExtensions: state.api.registry.signedExtensions,
          version: state.api.extrinsicType
        });
      } else {
        await tx.signAsync(pair, options);
      }
      const signDuration = Date.now() - signStartTime;
      const signedTxHex = tx.toHex();
      const signedAt = Date.now();
      const buildDuration = signedAt - startTime;

      const callDetails = `${tx.method.section}.${tx.method.method}`;
      subtensorClient.broadcastSignedTx(signedTxHex);
      const broadcastAt = Date.now();

      tx.send(({ status, events, dispatchError }) => {
        if (status.isInBlock || status.isFinalized) {
          walletService.refreshWalletState(address, true).catch(() => {});
          if (dispatchError) {
            let errorInfo = dispatchError.toString();
            if (dispatchError.isModule) {
              const decoded = subtensorClient.findMetaError(dispatchError);
              if (decoded) {
                errorInfo = `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`;
              }
            }
            finish({ success: false, error: errorInfo });
          } else {
            const blockHash = status.isInBlock ? status.asInBlock : status.asFinalized;

            Promise.resolve().then(async () => {
              let blockNumber = null;
              let txIndex = -1;
              try {
                if (subtensorClient.isConnected()) {
                  const block = await subtensorClient.getBlock(blockHash);
                  if (block && block.block) {
                    blockNumber = block.block.header.number.toNumber();
                    txIndex = block.block.extrinsics.findIndex(x => x.hash.toHex() === tx.hash.toHex());
                  }
                }
              } catch (err) {}

              finish({
                success: true,
                hash: tx.hash.toHex(),
                blockHash: blockHash.toHex(),
                blockNumber: blockNumber,
                txIndex: txIndex >= 0 ? txIndex : null,
                events: events || []
              });
            });
          }
        } else if (status.isError) {
          walletService.refreshNonceForwardOnly(address);
          finish({ success: false, error: 'Chain transaction error' });
        }
      }).then((unsub) => {
        if (settled && typeof unsub === 'function') unsub();
        else unsubscribe = unsub;
      }).catch(error => {
        walletService.refreshNonceForwardOnly(address);
        finish({ success: false, error: error.message });
      });

      if (meta && meta.trace) {
        flushTrace(meta.trace);
      }
      if (meta && meta.afterBroadcast && !meta.afterBroadcast.flushed) {
        meta.afterBroadcast.flushed = true;
        for (const fn of meta.afterBroadcast) {
          setImmediate(fn);
        }
      }
      const latencyStr = (meta && meta.detectedAt) ? ` | 距交易池触发: ${broadcastAt - meta.detectedAt}ms` : '';
      if (!meta || !meta.isPrivate) {
        log(
          'INFO',
          `[发送交易] 钱包【${pair.address.slice(-6)}】已签名并广播 ${callDetails} | ` +
            `Nonce: ${reservedNonce} | 哈希: ${tx.hash.toHex()} | ` +
            `签名耗时: ${signDuration}ms | 本地构建耗时: ${buildDuration}ms | ` +
            `广播前准备: ${broadcastAt - signedAt}ms${latencyStr}`,
          broadcastAt
        );
      }
    } catch (err) {
      walletService.refreshNonceForwardOnly(address);
      finish({ success: false, error: `Signing failed: ${err.message}` });
    }
  });
}

async function sendStrategicTx(tx, pair, txTimeoutMs = 15000, meta = null) {
  const res = await sendTx(tx, pair, txTimeoutMs, null, meta);
  if (res.success) {
    return {
      success: true,
      hash: res.hash,
      blockHash: res.blockHash,
      blockNumber: res.blockNumber,
      txIndex: res.txIndex
    };
  }
  return { success: false, error: res.error };
}

module.exports = {
  buildStakeTx,
  buildFixedLimitStakeTx,
  buildCachedSlippageStakeTx,
  sendStrategicTx
};
