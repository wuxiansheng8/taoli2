const dashing = require('./dashing');
const frontrun = require('./frontrun');
const emissionWatcher = require('./emissionWatcher');

async function handlePendingExtrinsic(parsed, fallbackSource = 'Mempool', blockNum = null, triggerExtras = null) {
  const callName = parsed.callName.toLowerCase();
  const isEmissionControl = /^sudo(_)?set(_)?subnet(_)?emission(_)?enabled$/i.test(callName);
  const hasMultisigWrapper = Array.isArray(parsed.wrappers) &&
    parsed.wrappers.some(wrapper => wrapper.section === 'multisig');

  // Multisig origin validation is currently implemented only for strategy 4.
  if (hasMultisigWrapper && !isEmissionControl) return true;
  
  if (/^register(_)?network$/i.test(callName)) {
    return dashing.handleRegisterNetwork(parsed);
  } else if (/^(start(_)?call)$/i.test(callName)) {
    return dashing.handleStartCall(parsed, fallbackSource, blockNum, triggerExtras);
  } else if (/^set(_)?subnet(_)?identity$/i.test(callName)) {
    return frontrun.handleRename(parsed, fallbackSource, blockNum, triggerExtras);
  } else if (/^(announceColdkeySwap|announce_coldkey_swap)$/i.test(callName)) {
    return frontrun.handleColdkeySwap(parsed, fallbackSource, blockNum, triggerExtras);
  } else if (isEmissionControl) {
    return emissionWatcher.handlePendingExtrinsic(parsed);
  }
  return true;
}

module.exports = {
  handlePendingExtrinsic
};
