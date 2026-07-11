const state = require('../state');
const config = require('../config');
const { log } = require('../logger');
const { extractSubtensorCalls, getCallKey } = require('../chain/parser');
const router = require('../strategies/router');
const subtensorClient = require('../chain/subtensorClient');

class MempoolScanner {
  start() {
    const settings = config.getSettings();
    const pollInterval = Math.max(1, settings.mempoolPollIntervalMs || 1);
    log('INFO', `[Mempool] 交易池高频扫描频率已生效：${pollInterval}ms`);
    
    if (state.pollTimer) clearTimeout(state.pollTimer);

    const generation = state.connectGeneration;

    const runPoll = async () => {
      if (generation !== state.connectGeneration || state.botStatus !== 'Running') return;
      await this.poll();
      if (generation !== state.connectGeneration || state.botStatus !== 'Running') return;
      
      const currentInterval = Math.max(1, config.getSettings().mempoolPollIntervalMs || 1);
      state.pollTimer = setTimeout(runPoll, currentInterval);
    };
    runPoll();
  }

  stop() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async poll() {
    if (state.isPolling || !subtensorClient.isConnected()) return;
    state.isPolling = true;
    const pollStart = Date.now();
    try {
      const pendingHexs = await subtensorClient.pendingExtrinsics();
      const pollDuration = Date.now() - pollStart;
      if (pollDuration > 150) {
        log('WARN', `[交易池轮询] 检测到节点响应延迟偏高 (${pollDuration}ms)，请留意网络波动或节点 CPU 负载！`);
      }
      if (!pendingHexs || pendingHexs.length === 0) {
        return;
      }

      const now = Date.now();

      // 限制每 10 秒清理一次过期的 seenHashes 和 seenActions 缓存
      if (now - state.lastTtlCleanupTime > 10000) {
        state.lastTtlCleanupTime = now;

        // 5分钟过期的哈希清理
      for (const [hash, entry] of state.getHashes()) {
        const timestamp = (entry && typeof entry === 'object') ? entry.timestamp : entry;
        if (now - timestamp > 5 * 60 * 1000) state.deleteHash(hash);
        }

        // 10分钟过期的动作清理
      for (const [action, timestamp] of state.getActions()) {
        if (now - timestamp > 10 * 60 * 1000) state.deleteAction(action);
        }
      }

      for (const hex of pendingHexs) {
        try {
          let ext;
          if (hex && typeof hex.toHex === 'function') {
            ext = hex;
          } else {
            ext = subtensorClient.createType('Extrinsic', hex.toString());
          }

          const actions = extractSubtensorCalls(ext);
          if (actions.length === 0) continue;

          for (const parsed of actions) {
            let netuid = null;
            if (parsed.args.netuid !== undefined) {
              netuid = Number(parsed.args.netuid.toString());
            } else if (parsed.args.destination_netuid !== undefined) {
              netuid = Number(parsed.args.destination_netuid.toString());
            } else if (parsed.args[1] !== undefined && typeof parsed.args[1].toNumber === 'function') {
              netuid = parsed.args[1].toNumber();
            } else if (parsed.args[0] !== undefined && /^(startCall|start_call)$/i.test(parsed.callName)) {
              netuid = Number(parsed.args[0].toString());
            }

            const isReg = /^register(_)?network$/i.test(parsed.callName);

            const callKey = getCallKey(parsed);
          const hashEntry = state.getHash(callKey);
            if (hashEntry) {
              if (hashEntry.handled) continue;
              if (now - hashEntry.timestamp < 3000) continue;
            }

            const isEmissionControl =
              /^(adminUtils|admin_utils)$/i.test(parsed.section) &&
              /^sudo(_)?set(_)?subnet(_)?emission(_)?enabled$/i.test(parsed.callName);

            if (
              isEmissionControl ||
              (
                /^subtensor(Module)?$/i.test(parsed.section) &&
                /^(registerNetwork|register_network|setSubnetIdentity|set_subnet_identity|announceColdkeySwap|announce_coldkey_swap|startCall|start_call)$/i.test(parsed.callName)
              )
            ) {
              const handled = await router.handlePendingExtrinsic(parsed, 'Mempool');
            state.markHash(callKey, {
                timestamp: now,
                netuid,
                tipTao: parsed.tipTao,
                isRegisterNetwork: isReg,
                handled: !!handled
              });
            } else {
            state.markHash(callKey, {
                timestamp: now,
                netuid,
                tipTao: parsed.tipTao,
                isRegisterNetwork: isReg,
                handled: true
              });
            }
          }
        } catch (err) {
          // Silent error
        }
      }
    } catch (e) {
      const now = Date.now();
      if (now - state.lastMempoolErrorTime > 60000) {
        state.lastMempoolErrorTime = now;
        const errMsg = e.message || String(e);
        if (errMsg.includes('unsafe') || errMsg.includes('Method not found') || errMsg.includes('reject') || errMsg.includes('forbidden') || errMsg.includes('unauthorized')) {
          log('ERROR', `[交易池监听失败] 节点拒绝了 pendingExtrinsics 请求！原因: "${errMsg}"。极大可能是因为本地节点未启用 Unsafe RPC 方法。请确保 Subtensor 节点配置了 --rpc-methods=Unsafe !`);
        } else {
          log('WARN', `获取交易池 Pending 交易失败: ${errMsg}`);
        }
      }
    } finally {
      state.isPolling = false;
    }
  }
}

module.exports = new MempoolScanner();
