const dashing = require('./dashing');
const frontrun = require('./frontrun');
const emissionWatcher = require('./emissionWatcher');

async function handlePendingExtrinsic(parsed, fallbackSource = 'Mempool', blockNum = null, triggerExtras = null) {
  const callName = parsed.callName.toLowerCase();
  
  if (/^register(_)?network$/i.test(callName)) {
    return dashing.handleRegisterNetwork(parsed);
  } else if (/^(start(_)?call)$/i.test(callName)) {
    return dashing.handleStartCall(parsed, fallbackSource, blockNum, triggerExtras);
  } else if (/^set(_)?subnet(_)?identity$/i.test(callName)) {
    return frontrun.handleRename(parsed, fallbackSource, blockNum, triggerExtras);
  } else if (/^(announceColdkeySwap|announce_coldkey_swap)$/i.test(callName)) {
    return frontrun.handleColdkeySwap(parsed, fallbackSource, blockNum, triggerExtras);
  } else if (/^sudo(_)?set(_)?subnet(_)?emission(_)?enabled$/i.test(callName)) {
    return emissionWatcher.handlePendingExtrinsic(parsed);
  }
  return true;
}

module.exports = {
  handlePendingExtrinsic
};
