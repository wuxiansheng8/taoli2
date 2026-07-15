const state = require('../state');
const config = require('../config');
const { log } = require('../logger');
const subnetCache = require('../chain/subnetCache');
const subtensorClient = require('../chain/subtensorClient');
const authorizer = require('./emissionAuthorizer');
const emissionFrontrun = require('./emissionFrontrun');

let unsubscribeSudoKey = null;

function readBoolean(value) {
  if (value === true || value === false) return value;
  if (value && typeof value.isTrue === 'boolean') return value.isTrue;
  const normalized = value?.toString().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function parseControlCall(parsed) {
  if (!parsed || !/^(adminUtils|admin_utils)$/i.test(parsed.section || '')) return null;
  if (!/^sudo(_)?set(_)?subnet(_)?emission(_)?enabled$/i.test(parsed.callName || '')) return null;

  const args = parsed.args || {};
  const netuidRaw = args.netuid !== undefined ? args.netuid : args[0];
  const enabledRaw = args.enabled !== undefined ? args.enabled : args[1];
  const netuid = Number(netuidRaw?.toString());
  const enabled = readBoolean(enabledRaw);

  if (!Number.isInteger(netuid) || netuid <= 0 || enabled === null) return null;
  return { netuid, enabled };
}

function handlePendingExtrinsic(parsed) {
  const control = parseControlCall(parsed);
  if (!control) return true;
  if (!authorizer.isAuthorizedRootCall(parsed)) return true;

  if (!control.enabled) {
    log('INFO', `[排放控制/Pending] 检测到可信的子网 #${control.netuid} 禁止排放指令。`);
    return true;
  }

  if (state.emissionEnabledByNetuid.get(control.netuid) !== false) {
    return true;
  }

  const wrappers = Array.isArray(parsed.wrappers) ? parsed.wrappers : [];
  const source = wrappers.some(wrapper => wrapper.section === 'multisig')
    ? 'Mempool-Multisig-Sudo'
    : 'Mempool-Sudo';
  emissionFrontrun.trigger({
    netuid: control.netuid,
    source,
    triggerId: parsed.txHash,
    callPath: [
      ...wrappers.map(wrapper => `${wrapper.section}.${wrapper.method}`),
      `${parsed.section}.${parsed.callName}`
    ].join(' -> ')
  });
  return true;
}

function handleBlockEvent(event, blockNumber) {
  if (!event) return;

  if (event.type === 'NETWORK_ADDED' && Number.isInteger(event.netuid)) {
    state.emissionEnabledByNetuid.set(event.netuid, false);
    return;
  }

  if (event.type !== 'SUBNET_EMISSION_ENABLED_SET' || !Number.isInteger(event.netuid)) {
    return;
  }

  state.emissionEnabledByNetuid.set(event.netuid, event.enabled);
  if (event.enabled === false) {
    state.emissionRuns.delete(event.netuid);
    log('INFO', `[排放控制/区块确认] 子网 #${event.netuid} 已禁止 TAO 侧排放。`);
    return;
  }

  if (event.enabled === true) {
    emissionFrontrun.trigger({
      netuid: event.netuid,
      source: 'Block-Event-Fallback',
      triggerId: `block:${blockNumber}:netuid:${event.netuid}`,
      triggerBlock: blockNumber
    });
  }
}

async function syncEmissionStates() {
  state.emissionEnabledByNetuid.clear();
  if (!subtensorClient.hasSubnetEmissionStorage()) return;

  const netuids = subnetCache.getRegisteredNetuids().filter(netuid => netuid > 0);
  if (netuids.length === 0) return;

  const values = await subtensorClient.querySubnetEmissionEnabledMulti(netuids);
  for (let index = 0; index < netuids.length; index++) {
    const enabled = readBoolean(values[index]);
    if (enabled !== null) {
      state.emissionEnabledByNetuid.set(netuids[index], enabled);
    }
  }
}

async function start() {
  stop(false);
  await syncEmissionStates();

  if (!subtensorClient.hasSudoKeyStorage()) {
    log('WARN', '[策略4] 当前 Runtime 未暴露 sudo.key，Pending Sudo 抢跑已关闭；区块事件兜底仍可用。');
    return;
  }

  unsubscribeSudoKey = await subtensorClient.subscribeSudoKey(key => {
    const value = key?.isSome ? key.unwrap().toString() : key?.toString();
    state.chainSudoKey = value && value !== 'None' ? value : null;
  });
}

function stop(clearRuns = true) {
  if (typeof unsubscribeSudoKey === 'function') {
    try { unsubscribeSudoKey(); } catch (error) {}
  }
  unsubscribeSudoKey = null;
  state.chainSudoKey = null;
  state.emissionEnabledByNetuid.clear();
  if (clearRuns) state.emissionRuns.clear();
}

function isEnabled() {
  return config.getSettings().emissionEnabled === true;
}

module.exports = {
  start,
  stop,
  isEnabled,
  handlePendingExtrinsic,
  handleBlockEvent,
  parseControlCall,
  syncEmissionStates
};
