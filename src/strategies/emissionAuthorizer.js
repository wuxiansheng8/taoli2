const state = require('../state');

const ROOT_SUDO_METHODS = new Set([
  'sudo',
  'sudoUncheckedWeight',
  'sudo_unchecked_weight'
]);

function isAuthorizedRootCall(parsed) {
  if (!parsed || !state.chainSudoKey || parsed.signer !== state.chainSudoKey) {
    return false;
  }

  const wrappers = Array.isArray(parsed.wrappers) ? parsed.wrappers : [];
  if (wrappers.some(wrapper => wrapper.section === 'proxy' || wrapper.section === 'multisig')) {
    return false;
  }

  return wrappers.some(wrapper =>
    wrapper.section === 'sudo' && ROOT_SUDO_METHODS.has(wrapper.method)
  );
}

module.exports = {
  isAuthorizedRootCall
};
