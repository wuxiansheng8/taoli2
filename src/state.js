class BotState {
  constructor() {
    this.api = null;
    this.provider = null;
    this.botStatus = 'Stopped'; // 'Stopped', 'Starting', 'Running', 'Error'
    this.currentActiveNode = 'Disconnected';
    this.currentLatency = -1;
    this.currentBlockHeight = 0;
    this.cachedBlockHash = null;
    this.systemUptimeStart = null;
    
    // Timers
    this.pollTimer = null;
    this.latencyTimer = null;
    this.broadcastLatencyTimer = null;
    this.broadcastLatencyTimeout = null;
    this.reconnectTimer = null;
    this.nonceSyncTimer = null;
    
    // Connection Generation Locks
    this.isPolling = false;
    this.isConnecting = false;
    this.connectGeneration = 0;
    
    // Wallets & Cryptography
    this.wallets = [];
    this.keyring = null;
    
    // Nonce & Balances Maps
    this.nextNonceByAddress = new Map();
    this.inFlightNonces = new Map();
    this.balanceByAddress = new Map();
    
    // Sniping & Deduplication States
    this.seenHashes = new Map();
    this.seenActions = new Map();
    this.dashingSuccessByNetuid = new Map();
    this.activeSnipesByNetuid = new Set();
    this.doubleStakingRegistered = new Set();
    
    // Subnet Cache
    this.subnetOwnersCache = new Map();
    this.subnetOwnerSet = new Set();
    this.subnetOwnerNetuidsMap = new Map();
    this.subnetHotkeysCache = new Map();
    this.subnetRegisteredAtCache = new Map();
    this.subnetNamesCache = new Map();
    this.chainSudoKey = null;
    this.emissionEnabledByNetuid = new Map();
    this.emissionRuns = new Map();
    this.successfulSyncCount = 0;
    
    // Broadcast State
    this.broadcastProviders = new Map(); // url -> WsProvider
    this.broadcastStatuses = new Map(); // url -> { status, latency }
    this.activeTimeoutRetryNumByWallet = new Map(); // netuid:walletName -> attemptNumber
    
    // Errors logging throttles
    this.lastMempoolErrorTime = 0;
    this.lastTtlCleanupTime = 0;
    this.lastNonceSyncErrorTime = 0;
  }

  getUptimeSeconds() {
    if (!this.systemUptimeStart) return 0;
    return Math.floor((Date.now() - this.systemUptimeStart) / 1000);
  }

  getStatusSnapshot() {
    const list = [];
    for (const [url, status] of this.broadcastStatuses.entries()) {
      list.push({
        url,
        status: status.status,
        latency: status.latency
      });
    }
    return {
      status: this.botStatus,
      activeNode: this.currentActiveNode,
      latency: this.currentLatency,
      blockHeight: this.currentBlockHeight,
      uptime: this.getUptimeSeconds(),
      broadcastNodes: list,
      serverTime: Date.now()
    };
  }

  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.latencyTimer) {
      clearInterval(this.latencyTimer);
      this.latencyTimer = null;
    }
    if (this.broadcastLatencyTimer) {
      clearInterval(this.broadcastLatencyTimer);
      this.broadcastLatencyTimer = null;
    }
    if (this.broadcastLatencyTimeout) {
      clearTimeout(this.broadcastLatencyTimeout);
      this.broadcastLatencyTimeout = null;
    }
    if (this.nonceSyncTimer) {
      clearInterval(this.nonceSyncTimer);
      this.nonceSyncTimer = null;
    }
  }

  // ============================================================================
  // Encapsulated State Mutators and Accessors
  // ============================================================================

  hasHash(key) {
    return this.seenHashes.has(key);
  }

  getHash(key) {
    return this.seenHashes.get(key);
  }

  markHash(key, data) {
    this.seenHashes.set(key, data);
  }

  getHashes() {
    return this.seenHashes.entries();
  }

  deleteHash(key) {
    this.seenHashes.delete(key);
  }

  hasAction(key) {
    return this.seenActions.has(key);
  }

  markAction(key, timestamp) {
    this.seenActions.set(key, timestamp);
  }

  getActions() {
    return this.seenActions.entries();
  }

  deleteAction(key) {
    this.seenActions.delete(key);
  }

  isStrategyLocked(lockKey) {
    return this.activeSnipesByNetuid.has(lockKey);
  }

  lockStrategy(lockKey) {
    this.activeSnipesByNetuid.add(lockKey);
  }

  unlockStrategy(lockKey) {
    this.activeSnipesByNetuid.delete(lockKey);
  }

  isStrategySuccessful(successKey) {
    return this.dashingSuccessByNetuid.get(successKey);
  }

  markStrategySuccess(successKey, status = true) {
    this.dashingSuccessByNetuid.set(successKey, status);
  }

  deleteStrategySuccess(successKey) {
    this.dashingSuccessByNetuid.delete(successKey);
  }

  clearStrategyState(strategy) {
    if (strategy === 'emission-frontrun') {
      const memoryClearedCount = this.emissionRuns.size;
      this.emissionRuns.clear();
      return { memoryClearedCount, lockClearedCount: 0 };
    }

    let memoryClearedCount = 0;
    let lockClearedCount = 0;

    // Memory success state
    for (const key of this.dashingSuccessByNetuid.keys()) {
      if (
        (strategy === 'new-subnet' && (
          key.startsWith('new-subnet-primary:') ||
          key.startsWith('new-subnet-double:') ||
          key.startsWith('新子网打新:')
        )) ||
        (strategy === 'rename' && (key.startsWith('rename:') || key.startsWith('改名抢跑:'))) ||
        (strategy === 'coldkey-swap' && (key.startsWith('coldkey-swap:') || key.startsWith('冷键交换抢跑:')))
      ) {
        this.dashingSuccessByNetuid.delete(key);
        memoryClearedCount++;
      }
    }
    // Memory locks
    for (const key of Array.from(this.activeSnipesByNetuid)) {
      if (strategy === 'new-subnet') {
        if (
          typeof key === 'number' ||
          (typeof key === 'string' && (
            key.startsWith('new-subnet-primary:') ||
            key.startsWith('new-subnet-double:') ||
            !key.startsWith('lock:')
          ))
        ) {
          this.activeSnipesByNetuid.delete(key);
          lockClearedCount++;
        }
      } else if (strategy === 'rename') {
        if (typeof key === 'string' && (key.startsWith('rename:') || key.startsWith('lock:改名抢跑:'))) {
          this.activeSnipesByNetuid.delete(key);
          lockClearedCount++;
        }
      } else if (strategy === 'coldkey-swap') {
        if (typeof key === 'string' && (key.startsWith('coldkey-swap:') || key.startsWith('lock:冷键交换抢跑:'))) {
          this.activeSnipesByNetuid.delete(key);
          lockClearedCount++;
        }
      }
    }
    return { memoryClearedCount, lockClearedCount };
  }
}

module.exports = new BotState();
