const { blake2AsHex } = require('@polkadot/util-crypto');
const state = require('../state');
const subtensorClient = require('./subtensorClient');

function toArray(value) {
  if (!value) return [];
  return typeof value.toArray === 'function' ? value.toArray() : Array.from(value);
}

function tupleItems(tuple) {
  return toArray(tuple?.[0]);
}

function findDefinition(definitions, proxy) {
  return definitions.find(definition => {
    if (definition.delegate.toString() !== proxy.delegate) return false;
    return !proxy.forceProxyType ||
      definition.proxyType.toString() === proxy.forceProxyType;
  });
}

function filterAllowsCall(filter, call) {
  const mode = filter?.filterMode;
  if (mode?.isAllowAll === true) return true;
  if (mode?.isAllow !== true || !call?.callIndex) return false;

  const [palletIndex, callIndex] = Array.from(call.callIndex);
  return toArray(mode.asAllow).some(info =>
    Number(info.palletIndex.toString()) === palletIndex &&
    Number(info.callIndex.toString()) === callIndex &&
    info.constraint?.isSome !== true
  );
}

function announcementIsMature(announcements, proxy, definition) {
  const callHash = blake2AsHex(proxy.call.toU8a(), 256).toLowerCase();
  const delay = Number(definition.delay.toString());
  const executionBlock = state.currentBlockHeight + 1;

  return announcements.some(announcement => {
    const height = Number(announcement.height.toString());
    return announcement.real.toString() === proxy.real &&
      announcement.callHash.toHex().toLowerCase() === callHash &&
      executionBlock >= height &&
      executionBlock - height >= delay;
  });
}

async function validateOne(proxy) {
  if (!proxy.real || !proxy.delegate || !proxy.call) {
    return { allowed: false, reason: 'Proxy 参数不完整' };
  }

  const [definitionsTuple, announcementsTuple] = await Promise.all([
    subtensorClient.queryProxyDefinitions(proxy.real),
    proxy.announced
      ? subtensorClient.queryProxyAnnouncements(proxy.delegate)
      : Promise.resolve(null)
  ]);

  const definition = findDefinition(tupleItems(definitionsTuple), proxy);
  if (!definition) {
    return { allowed: false, reason: '不存在匹配的链上代理关系' };
  }

  const delay = Number(definition.delay.toString());
  if (!proxy.announced && delay !== 0) {
    return { allowed: false, reason: `普通 proxy 不能使用 delay=${delay} 的代理` };
  }

  if (
    proxy.announced &&
    !announcementIsMature(tupleItems(announcementsTuple), proxy, definition)
  ) {
    return { allowed: false, reason: '公告不存在或下一块尚未成熟' };
  }

  const proxyTypeIndex = Number(definition.proxyType.index);
  const filters = toArray(await subtensorClient.callProxyFilters([proxyTypeIndex]));
  const filter = filters[0];

  if (!filterAllowsCall(filter, proxy.call)) {
    return {
      allowed: false,
      reason: `${definition.proxyType.toString()} 不允许执行 ` +
        `${proxy.call.section}.${proxy.call.method}`
    };
  }

  return {
    allowed: true,
    proxyType: definition.proxyType.toString(),
    announced: proxy.announced
  };
}

async function validateProxyWrappers(parsed) {
  const proxies = (parsed.wrappers || [])
    .filter(wrapper => wrapper.section === 'proxy');
  let lastValidation = null;

  for (const proxy of proxies) {
    lastValidation = await validateOne(proxy);
    if (!lastValidation.allowed) return lastValidation;
  }

  return lastValidation || { allowed: true };
}

module.exports = {
  validateProxyWrappers
};
