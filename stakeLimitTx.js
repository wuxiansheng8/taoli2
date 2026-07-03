function toLimitPricePlanck(maxPriceLimit) {
  const limit = Number(maxPriceLimit || 0);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('Strategy 1 fixed max price must be greater than 0');
  }
  return BigInt(Math.floor(limit * 1e9));
}

function buildFixedLimitStakeTx(api, hotkey, netuid, amountBigInt, maxPriceLimit, allowPartial = true) {
  if (!api || !api.tx || !api.tx.subtensorModule || typeof api.tx.subtensorModule.addStakeLimit !== 'function') {
    throw new Error('Current node/runtime does not support addStakeLimit');
  }
  return api.tx.subtensorModule.addStakeLimit(
    hotkey,
    netuid,
    amountBigInt,
    toLimitPricePlanck(maxPriceLimit),
    allowPartial
  );
}

module.exports = {
  buildFixedLimitStakeTx,
  toLimitPricePlanck
};
