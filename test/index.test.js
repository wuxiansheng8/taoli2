const test = require('node:test');
const assert = require('node:assert/strict');

const state = require('../src/state');
const config = require('../src/config');
const privateWallet = require('../src/privateWallet');
const walletService = require('../src/wallet/walletService');
const subtensorClient = require('../src/chain/subtensorClient');
const transactionService = require('../src/transaction/transactionService');
const { extractSubtensorCalls, getCallKey, decodeSubtensorEvent } = require('../src/chain/parser');
const { getStrategyKeys, validateExecutionPlan } = require('../src/strategies/executor');
const router = require('../src/strategies/router');
const dashing = require('../src/strategies/dashing');
const frontrun = require('../src/strategies/frontrun');
const emissionAuthorizer = require('../src/strategies/emissionAuthorizer');
const emissionWatcher = require('../src/strategies/emissionWatcher');
const emissionFrontrun = require('../src/strategies/emissionFrontrun');
const runtime = require('../src/runtime');
const bot = require('../bot');

test('extracts nested utility batch calls', () => {
  const mockExtrinsic = {
    hash: { toHex: () => '0xext_hash' },
    signer: { toString: () => '5ColdkeyAddress' },
    tip: { toString: () => '100000000' },
    nonce: { toString: () => '42' },
    method: {
      section: 'utility',
      method: 'batch',
      args: [{
        toArray: () => [
          { section: 'subtensorModule', method: 'start_call', args: [{ toString: () => '1' }] },
          {
            section: 'subtensorModule',
            method: 'set_subnet_identity',
            args: [{ toString: () => '2' }, { toHuman: () => 'SubnetName' }]
          }
        ]
      }]
    }
  };

  const calls = extractSubtensorCalls(mockExtrinsic);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signer, '5ColdkeyAddress');
  assert.equal(calls[0].tipTao, 0.1);
  assert.equal(calls[0].nonce, 42);
  assert.equal(calls[1].callName, 'set_subnet_identity');
});

test('propagates real signer through proxy and proxy_announced calls', () => {
  const createExtrinsic = (method, args) => ({
    hash: { toHex: () => `0x${method}` },
    signer: { toString: () => '5ProxySignerAddress' },
    tip: { toString: () => '0' },
    nonce: { toString: () => '10' },
    method: { section: 'proxy', method, args }
  });
  const innerCall = { section: 'subtensorModule', method: 'start_call', args: [{ toString: () => '3' }] };

  const proxy = extractSubtensorCalls(createExtrinsic('proxy', [
    { toString: () => '5RealSenderAddress' },
    null,
    innerCall
  ]));
  const announced = extractSubtensorCalls(createExtrinsic('proxy_announced', [
    { toString: () => '5DelegateAddress' },
    { toString: () => '5AnnouncedRealAddress' },
    null,
    innerCall
  ]));

  assert.equal(proxy[0].signer, '5RealSenderAddress');
  assert.equal(announced[0].signer, '5AnnouncedRealAddress');
});

test('extracts emission controls only through supported sudo wrappers', () => {
  const innerCall = {
    section: 'adminUtils',
    method: 'sudo_set_subnet_emission_enabled',
    args: [{ toString: () => '12' }, { toString: () => 'true' }],
    meta: {
      args: [
        { name: { toString: () => 'netuid' } },
        { name: { toString: () => 'enabled' } }
      ]
    }
  };
  const extrinsic = {
    hash: { toHex: () => '0xsudo' },
    signer: { toString: () => '5SudoKey' },
    tip: { toString: () => '0' },
    nonce: { toString: () => '1' },
    method: { section: 'sudo', method: 'sudo', args: [innerCall] }
  };

  const [parsed] = extractSubtensorCalls(extrinsic);
  assert.equal(parsed.section, 'adminUtils');
  assert.equal(parsed.callName, 'sudo_set_subnet_emission_enabled');
  assert.equal(parsed.args.netuid.toString(), '12');
  assert.deepEqual(parsed.wrappers, [{ section: 'sudo', method: 'sudo' }]);

  extrinsic.method.method = 'sudoAs';
  const [sudoAs] = extractSubtensorCalls(extrinsic);
  assert.equal(sudoAs.section, 'sudo');
  assert.equal(sudoAs.callName, 'sudoAs');
});

test('authorizes only the live sudo key and rejects direct or proxy paths', () => {
  state.chainSudoKey = '5SudoKey';
  const base = {
    signer: '5SudoKey',
    wrappers: [{ section: 'sudo', method: 'sudo' }]
  };

  assert.equal(emissionAuthorizer.isAuthorizedRootCall(base), true);
  assert.equal(emissionAuthorizer.isAuthorizedRootCall({ ...base, signer: '5Fake' }), false);
  assert.equal(emissionAuthorizer.isAuthorizedRootCall({ ...base, wrappers: [] }), false);
  assert.equal(emissionAuthorizer.isAuthorizedRootCall({
    ...base,
    wrappers: [
      { section: 'proxy', method: 'proxy' },
      { section: 'sudo', method: 'sudo' }
    ]
  }), false);
  state.chainSudoKey = null;
});

test('builds stable de-duplication keys', () => {
  const key = getCallKey({
    txHash: '0xhash',
    callPath: '0.1',
    section: 'subtensorModule',
    callName: 'start_call',
    args: { netuid: { toString: () => '4' } }
  });
  assert.equal(key, '0xhash:0.1:subtensorModule:start_call:4');
});

test('normalizes Subtensor events without leaking positional fields', () => {
  const stake = decodeSubtensorEvent({
    section: 'subtensorModule',
    method: 'StakeAdded',
    data: [
      { toString: () => '5Coldkey' },
      { toString: () => '5Hotkey' },
      { toString: () => '5,000,000,000' },
      null,
      { toString: () => '7' }
    ]
  }, 100, 2);
  const emission = decodeSubtensorEvent({
    section: 'subtensorModule',
    method: 'FirstEmissionBlockNumberSet',
    data: [{ toString: () => '8' }, { toString: () => '12,345' }]
  });

  assert.equal(stake.type, 'STAKE_ADDED');
  assert.equal(stake.amountTao, 5);
  assert.equal(stake.netuid, 7);
  assert.equal(stake.blockNumber, 100);
  assert.equal(emission.type, 'FIRST_EMISSION_BLOCK_SET');
  assert.equal(emission.activationBlock, 12345);
  assert.equal(emission.amountTao, null);

  assert.equal(decodeSubtensorEvent({
    section: 'subtensorModule',
    method: 'NetworkAdded',
    data: [{ toString: () => '9' }]
  }).type, 'NETWORK_ADDED');
  assert.equal(decodeSubtensorEvent({
    section: 'subtensorModule',
    method: 'SubnetIdentitySet',
    data: [{ toString: () => '9' }]
  }).type, 'SUBNET_IDENTITY_SET');
  assert.equal(decodeSubtensorEvent({
    section: 'subtensorModule',
    method: 'ColdkeySwapAnnounced',
    data: [{ toString: () => '5Coldkey' }, { toString: () => '0xhash' }]
  }).type, 'COLDKEY_SWAP_ANNOUNCED');

  const toggle = decodeSubtensorEvent({
    section: 'adminUtils',
    method: 'SubnetEmissionEnabledSet',
    data: [{ toString: () => '12' }, { toString: () => 'true' }]
  });
  assert.equal(toggle.type, 'SUBNET_EMISSION_ENABLED_SET');
  assert.equal(toggle.netuid, 12);
  assert.equal(toggle.enabled, true);
});

test('keeps primary and double strategy locks separate and preserves legacy cooldown key', () => {
  const primary = getStrategyKeys('new-subnet-primary', 8, '5Hotkey');
  const double = getStrategyKeys('new-subnet-double', 8, '5Hotkey');

  assert.notEqual(primary.lockKey, double.lockKey);
  assert.equal(primary.cooldownKey, 'new-subnet:8');
  assert.equal(double.cooldownKey, 'new-subnet-double:8');
});

test('rejects an invalid fixed price before strategy state is mutated', () => {
  assert.equal(validateExecutionPlan({
    strategyId: 'new-subnet-primary',
    netuid: 8,
    hotkey: '5Hotkey',
    priceMode: 'fixed',
    maxPriceLimit: 0
  }), 'Invalid fixed max price');
});

test('clears current and legacy strategy state keys', () => {
  state.lockStrategy('new-subnet-primary:8');
  state.lockStrategy('new-subnet-double:8');
  state.markStrategySuccess('new-subnet-primary:8:5Hotkey', true);
  state.markStrategySuccess('新子网打新:8:5Hotkey:Primary', true);

  const cleared = state.clearStrategyState('new-subnet');

  assert.equal(state.isStrategyLocked('new-subnet-primary:8'), false);
  assert.equal(state.isStrategyLocked('new-subnet-double:8'), false);
  assert.equal(state.isStrategySuccessful('new-subnet-primary:8:5Hotkey'), undefined);
  assert.equal(state.isStrategySuccessful('新子网打新:8:5Hotkey:Primary'), undefined);
  assert.equal(cleared.memoryClearedCount, 2);
  assert.equal(cleared.lockClearedCount, 2);
});

test('respects allowPartialStaking=false for fixed-limit transactions', () => {
  const originals = {
    getSettings: config.getSettings,
    isConnected: subtensorClient.isConnected,
    hasAddStakeLimit: subtensorClient.hasAddStakeLimit,
    buildAddStakeLimitTx: subtensorClient.buildAddStakeLimitTx
  };
  let receivedAllowPartial = null;
  try {
    config.getSettings = () => ({ allowPartialStaking: false });
    subtensorClient.isConnected = () => true;
    subtensorClient.hasAddStakeLimit = () => true;
    subtensorClient.buildAddStakeLimitTx = (...args) => {
      receivedAllowPartial = args[4];
      return { args };
    };

    transactionService.buildFixedLimitStakeTx('5Hotkey', 8, 1_000_000_000n, 2);
    assert.equal(receivedAllowPartial, false);
  } finally {
    Object.assign(config, { getSettings: originals.getSettings });
    Object.assign(subtensorClient, {
      isConnected: originals.isConnected,
      hasAddStakeLimit: originals.hasAddStakeLimit,
      buildAddStakeLimitTx: originals.buildAddStakeLimitTx
    });
  }
});

test('builds strategy 4 limit price from one subnet price and configured slippage', () => {
  const originals = {
    getSettings: config.getSettings,
    isConnected: subtensorClient.isConnected,
    hasAddStakeLimit: subtensorClient.hasAddStakeLimit,
    buildAddStakeLimitTx: subtensorClient.buildAddStakeLimitTx
  };
  let received = null;
  try {
    config.getSettings = () => ({ allowPartialStaking: false });
    subtensorClient.isConnected = () => true;
    subtensorClient.hasAddStakeLimit = () => true;
    subtensorClient.buildAddStakeLimitTx = (...args) => {
      received = args;
      return { args };
    };

    transactionService.buildCachedSlippageStakeTx(
      '5Hotkey',
      12,
      1_000_000_000n,
      2_000_000_000n,
      0.05
    );
    assert.equal(received[3], 2_100_000_000n);
    assert.equal(received[4], false);
  } finally {
    config.getSettings = originals.getSettings;
    Object.assign(subtensorClient, {
      isConnected: originals.isConnected,
      hasAddStakeLimit: originals.hasAddStakeLimit,
      buildAddStakeLimitTx: originals.buildAddStakeLimitTx
    });
  }
});

test('uses synchronous local signing only for the strategy 4 fast path', async () => {
  const address = '5FastSignWallet';
  const originals = {
    api: state.api,
    cachedBlockHash: state.cachedBlockHash,
    currentBlockHeight: state.currentBlockHeight,
    broadcastSignedTx: subtensorClient.broadcastSignedTx,
    refreshWalletState: walletService.refreshWalletState
  };
  let syncSigned = false;
  let asyncSigned = false;
  let signOptions = null;
  try {
    state.api = {
      genesisHash: '0xgenesis',
      runtimeVersion: { specVersion: 1, transactionVersion: 1 },
      extrinsicType: 4,
      registry: {
        createType: (type, value) => ({ type, value }),
        signedExtensions: ['CheckNonce']
      }
    };
    state.cachedBlockHash = '0xblock';
    state.currentBlockHeight = 100;
    walletService.setNonceForwardOnly(address, 7);
    subtensorClient.broadcastSignedTx = () => {};
    walletService.refreshWalletState = async () => {};

    const tx = {
      method: { section: 'subtensorModule', method: 'addStakeLimit' },
      hash: { toHex: () => '0xtx' },
      sign: (pair, options) => {
        syncSigned = true;
        signOptions = options;
      },
      signAsync: async () => {
        asyncSigned = true;
      },
      toHex: () => '0xsigned',
      send: callback => {
        setImmediate(() => callback({
          status: {
            isInBlock: true,
            isFinalized: false,
            asInBlock: { toHex: () => '0xincluded' }
          },
          events: [],
          dispatchError: null
        }));
        return Promise.resolve(() => {});
      }
    };

    const result = await transactionService.sendStrategicTx(
      tx,
      { address },
      1000,
      { fastSign: true, isPrivate: true }
    );
    assert.equal(result.success, true);
    assert.equal(syncSigned, true);
    assert.equal(asyncSigned, false);
    assert.equal(signOptions.nonce, 7);
    assert.equal(signOptions.blockHash, '0xblock');
  } finally {
    state.api = originals.api;
    state.cachedBlockHash = originals.cachedBlockHash;
    state.currentBlockHeight = originals.currentBlockHeight;
    subtensorClient.broadcastSignedTx = originals.broadcastSignedTx;
    walletService.refreshWalletState = originals.refreshWalletState;
    state.nextNonceByAddress.delete(address);
    state.inFlightNonces.delete(address);
  }
});

test('routes trusted emission controls and clears state on disable events', () => {
  const originalTrigger = emissionFrontrun.trigger;
  const triggers = [];
  try {
    emissionFrontrun.trigger = payload => {
      triggers.push(payload);
      return true;
    };
    state.chainSudoKey = '5SudoKey';
    state.emissionEnabledByNetuid.set(12, false);

    const parsed = {
      section: 'adminUtils',
      callName: 'sudo_set_subnet_emission_enabled',
      signer: '5SudoKey',
      txHash: '0xtrusted',
      wrappers: [{ section: 'sudo', method: 'sudo' }],
      args: {
        netuid: { toString: () => '12' },
        enabled: { toString: () => 'true' }
      }
    };
    emissionWatcher.handlePendingExtrinsic(parsed);
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].netuid, 12);

    emissionWatcher.handlePendingExtrinsic({ ...parsed, signer: '5Fake', txHash: '0xfake' });
    assert.equal(triggers.length, 1);

    state.emissionRuns.set(12, { status: 'success' });
    emissionWatcher.handleBlockEvent({
      type: 'SUBNET_EMISSION_ENABLED_SET',
      netuid: 12,
      enabled: false
    }, 100);
    assert.equal(state.emissionRuns.has(12), false);
    assert.equal(state.emissionEnabledByNetuid.get(12), false);
  } finally {
    emissionFrontrun.trigger = originalTrigger;
    state.chainSudoKey = null;
    state.emissionEnabledByNetuid.clear();
    state.emissionRuns.clear();
  }
});

test('strategy 4 queries only its target price once for all wallets', async () => {
  const originals = {
    getSettings: config.getSettings,
    getSubnetPrice: require('../src/chain/subnetCache').getSubnetPrice,
    resolveHotkey: require('../src/chain/subnetCache').resolveHotkey,
    buildCachedSlippageStakeTx: transactionService.buildCachedSlippageStakeTx,
    sendStrategicTx: transactionService.sendStrategicTx,
    wallets: state.wallets
  };
  const subnetCache = require('../src/chain/subnetCache');
  let priceQueries = 0;
  let builds = 0;
  try {
    config.getSettings = () => ({
      emissionEnabled: true,
      emissionAmount: 1,
      emissionSlippageLimit: 0.05,
      emissionRetries: 1,
      emissionBurstCount: 2,
      emissionIntervalMs: 1,
      emissionTimeoutMs: 1000
    });
    subnetCache.resolveHotkey = () => '5Hotkey';
    subnetCache.getSubnetPrice = async netuid => {
      priceQueries++;
      assert.equal(netuid, 12);
      return 2_000_000_000n;
    };
    transactionService.buildCachedSlippageStakeTx = () => {
      builds++;
      return {};
    };
    transactionService.sendStrategicTx = async () => ({ success: false, error: 'test' });
    state.wallets = [
      { name: 'Wallet1', pair: {}, enabled: true, isPrivate: true },
      { name: 'Wallet2', pair: {}, enabled: true, isPrivate: true }
    ];
    state.emissionRuns.clear();

    assert.equal(emissionFrontrun.trigger({
      netuid: 12,
      source: 'Test',
      triggerId: '0xprice'
    }), true);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(priceQueries, 1);
    assert.equal(builds, 4);
    assert.equal(state.emissionRuns.get(12).status, 'failed');
  } finally {
    config.getSettings = originals.getSettings;
    subnetCache.getSubnetPrice = originals.getSubnetPrice;
    subnetCache.resolveHotkey = originals.resolveHotkey;
    transactionService.buildCachedSlippageStakeTx = originals.buildCachedSlippageStakeTx;
    transactionService.sendStrategicTx = originals.sendStrategicTx;
    state.wallets = originals.wallets;
    state.emissionRuns.clear();
  }
});

test('allocates and releases nonces monotonically', () => {
  const address = '5ColdkeyNonceTest';
  walletService.setNonceForwardOnly(address, 5);
  assert.equal(walletService.reserveNonce(address), 5);
  assert.equal(walletService.reserveNonce(address), 6);
  walletService.releaseNonce(address, 5);
  walletService.releaseNonce(address, 6);
  state.nextNonceByAddress.delete(address);
  state.inFlightNonces.delete(address);
});

test('identifies private and public wallets', () => {
  const wallets = [
    { name: 'PublicAcc', isPrivate: false },
    { name: 'PrivateAcc', isPrivate: true }
  ];
  assert.equal(privateWallet.isPrivate(wallets[0]), false);
  assert.equal(privateWallet.isPrivate(wallets[1]), true);
  assert.equal(privateWallet.hasPublic(wallets), true);
});

test('routes all supported trigger calls to the correct strategy handler', async () => {
  const originals = {
    register: dashing.handleRegisterNetwork,
    start: dashing.handleStartCall,
    rename: frontrun.handleRename,
    swap: frontrun.handleColdkeySwap,
    emission: emissionWatcher.handlePendingExtrinsic
  };
  const calls = [];
  try {
    dashing.handleRegisterNetwork = async () => calls.push('register');
    dashing.handleStartCall = async () => calls.push('start');
    frontrun.handleRename = async () => calls.push('rename');
    frontrun.handleColdkeySwap = async () => calls.push('swap');
    emissionWatcher.handlePendingExtrinsic = async () => calls.push('emission');

    await router.handlePendingExtrinsic({ callName: 'register_network' });
    await router.handlePendingExtrinsic({ callName: 'start_call' });
    await router.handlePendingExtrinsic({ callName: 'set_subnet_identity' });
    await router.handlePendingExtrinsic({ callName: 'announce_coldkey_swap' });
    await router.handlePendingExtrinsic({ callName: 'sudo_set_subnet_emission_enabled' });
    assert.deepEqual(calls, ['register', 'start', 'rename', 'swap', 'emission']);
  } finally {
    dashing.handleRegisterNetwork = originals.register;
    dashing.handleStartCall = originals.start;
    frontrun.handleRename = originals.rename;
    frontrun.handleColdkeySwap = originals.swap;
    emissionWatcher.handlePendingExtrinsic = originals.emission;
  }
});

test('stopBot clears connection timers and broadcast resources', () => {
  let providerDisconnected = false;
  let apiDisconnected = false;
  const generation = state.connectGeneration;
  state.botStatus = 'Running';
  state.broadcastLatencyTimeout = setTimeout(() => {}, 60_000);
  state.broadcastLatencyTimer = setInterval(() => {}, 60_000);
  state.broadcastProviders.set('test', { disconnect: () => { providerDisconnected = true; } });
  state.api = { disconnect: () => { apiDisconnected = true; } };

  runtime.stopBot();

  assert.equal(state.botStatus, 'Stopped');
  assert.equal(state.connectGeneration, generation + 1);
  assert.equal(state.broadcastLatencyTimeout, null);
  assert.equal(state.broadcastLatencyTimer, null);
  assert.equal(state.broadcastProviders.size, 0);
  assert.equal(providerDisconnected, true);
  assert.equal(apiDisconnected, true);
});

test('preserves the original bot public API contract', () => {
  const expectedFunctions = [
    'startBot',
    'stopBot',
    'testTelegram',
    'testFlashDuty',
    'testApiUrl',
    'refreshAllWallets',
    'reloadWallets',
    'getWalletsStatus',
    'getWallets',
    'log',
    'getUptimeSeconds',
    'getLogs',
    'getStatus',
    'setLogCallback',
    'setBlockCallback',
    'clearCooldown'
  ];
  for (const name of expectedFunctions) {
    assert.equal(typeof bot[name], 'function', `${name} must remain available`);
  }
});
