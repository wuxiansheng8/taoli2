const { createKeyMulti, decodeAddress } = require('@polkadot/util-crypto');
const { u8aEq } = require('@polkadot/util');
const state = require('../state');

const ROOT_SUDO_METHODS = new Set([
  'sudo',
  'sudoUncheckedWeight',
  'sudo_unchecked_weight'
]);

function matchesSudoKey(parsed, wrappers) {
  const multisigWrappers = wrappers.filter(wrapper => wrapper.section === 'multisig');
  if (multisigWrappers.length === 0) return parsed.signer === state.chainSudoKey;
  if (multisigWrappers.length !== 1) return false;

  const { threshold, otherSignatories } = multisigWrappers[0];
  if (
    !Number.isInteger(threshold) ||
    threshold < 2 ||
    !Array.isArray(otherSignatories)
  ) {
    return false;
  }

  const signatories = [parsed.signer, ...otherSignatories];
  if (
    signatories.length < threshold ||
    new Set(signatories).size !== signatories.length
  ) {
    return false;
  }

  try {
    const multisigAccount = createKeyMulti(signatories, threshold);
    return u8aEq(multisigAccount, decodeAddress(state.chainSudoKey));
  } catch (error) {
    return false;
  }
}

function isAuthorizedRootCall(parsed) {
  if (!parsed || !state.chainSudoKey) return false;

  const wrappers = Array.isArray(parsed.wrappers) ? parsed.wrappers : [];
  if (wrappers.some(wrapper => wrapper.section === 'proxy')) return false;

  const hasRootSudoWrapper = wrappers.some(wrapper =>
    wrapper.section === 'sudo' && ROOT_SUDO_METHODS.has(wrapper.method)
  );
  return hasRootSudoWrapper && matchesSudoKey(parsed, wrappers);
}

module.exports = {
  isAuthorizedRootCall
};
