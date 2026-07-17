const dashing = require('./dashing');
const frontrun = require('./frontrun');
const emissionWatcher = require('./emissionWatcher');
const proxyValidator = require('../chain/proxyValidator');
const { log } = require('../logger');

async function handlePendingExtrinsic(parsed, fallbackSource = 'Mempool', blockNum = null, triggerExtras = null) {
  const callName = parsed.callName.toLowerCase();
  const isEmissionControl = /^sudo(_)?set(_)?subnet(_)?emission(_)?enabled$/i.test(callName);
  const hasProxyWrapper = Array.isArray(parsed.wrappers) &&
    parsed.wrappers.some(wrapper => wrapper.section === 'proxy');
  const hasMultisigWrapper = Array.isArray(parsed.wrappers) &&
    parsed.wrappers.some(wrapper => wrapper.section === 'multisig');

  if (hasProxyWrapper) {
    const startedAt = Date.now();
    try {
      const validation = await proxyValidator.validateProxyWrappers(parsed);
      const elapsedMs = Date.now() - startedAt;

      if (!validation.allowed) {
        log('WARN', `[Proxy校验/拒绝] ${parsed.section}.${parsed.callName} | ${validation.reason} | ${elapsedMs}ms`);
        return true;
      }

      log(
        'INFO',
        `[Proxy校验/通过] ${parsed.section}.${parsed.callName} | 类型: ${validation.proxyType} | ` +
        `模式: ${validation.announced ? 'proxyAnnounced' : 'proxy'} | ${elapsedMs}ms`
      );
    } catch (error) {
      log('WARN', `[Proxy校验/异常] ${parsed.section}.${parsed.callName} | ${error.message} | ${Date.now() - startedAt}ms`);
      return true;
    }
  }

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
