function optionToString(value) {
  if (value === null || value === undefined || value.isNone === true) {
    return null;
  }

  const unwrapped = value.isSome === true && typeof value.unwrap === 'function'
    ? value.unwrap()
    : value;

  return unwrapped?.toString() || null;
}

function codecToSortableBigInt(value) {
  if (value === null || value === undefined) return 0n;

  const json = typeof value.toJSON === 'function' ? value.toJSON() : value;
  if (json && typeof json === 'object' && !Array.isArray(json) && 'bits' in json) {
    return codecToSortableBigInt(json.bits);
  }
  if (typeof json === 'bigint') return json;
  if (typeof json === 'number') return BigInt(Math.trunc(json));
  if (typeof json === 'string') {
    const normalized = json.replace(/,/g, '').trim();
    return normalized.startsWith('0x') ? BigInt(normalized) : BigInt(normalized || '0');
  }

  const raw = value.toString ? value.toString() : String(value);
  const normalized = raw.replace(/,/g, '').trim();
  return normalized.startsWith('0x') ? BigInt(normalized) : BigInt(normalized || '0');
}

function extractSubtensorCalls(ext) {
  if (!ext || !ext.method) return [];
  const signer = ext.signer ? ext.signer.toString() : 'unsigned';
  const txHash = ext.hash ? ext.hash.toHex() : 'unknown';
  const tipBigInt = ext.tip ? BigInt(ext.tip.toString()) : 0n;
  const tipTao = Number(tipBigInt) / 1e9;
  const nonce = ext.nonce !== undefined && ext.nonce !== null ? Number(ext.nonce.toString()) : null;

  function recurse(call, currentPath = "0", currentSigner = signer, wrappers = []) {
    if (!call) return [];
    const section = String(call.section || '').trim();
    const method = String(call.method || '').trim();

    if (section === 'utility' && /^(batch|batchAll|batch_all|forceBatch|force_batch)$/i.test(method)) {
      const firstArg = call.args && call.args[0];
      const subcalls = (firstArg && typeof firstArg.toArray === 'function') ? firstArg.toArray() : (firstArg || []);
      let list = [];
      for (let i = 0; i < subcalls.length; i++) {
        list = list.concat(recurse(subcalls[i], `${currentPath}.${i}`, currentSigner, [
          ...wrappers,
          { section: 'utility', method }
        ]));
      }
      return list;
    }

    if (section === 'proxy' && /^(proxy|proxyAnnounced|proxy_announced)$/i.test(method)) {
      const argsList = call.args && typeof call.args.toArray === 'function'
        ? call.args.toArray()
        : (call.args || []);
      const announced = !/^proxy$/i.test(method);
      const delegateRaw = announced ? argsList[0] : currentSigner;
      const realRaw = announced ? argsList[1] : argsList[0];
      const forceTypeRaw = announced ? argsList[2] : argsList[1];
      let innerCall = announced ? argsList[3] : argsList[2];

      if (innerCall?.isSome === true && typeof innerCall.unwrap === 'function') {
        innerCall = innerCall.unwrap();
      }

      if (!innerCall?.section || !innerCall?.method) return [];

      const real = realRaw?.toString() || null;
      return recurse(innerCall, `${currentPath}.p`, real || currentSigner, [
        ...wrappers,
        {
          section: 'proxy',
          method,
          announced,
          delegate: delegateRaw?.toString() || null,
          real,
          forceProxyType: optionToString(forceTypeRaw),
          call: innerCall
        }
      ]);
    }

    if (section === 'multisig' && /^(asMulti|as_multi)$/i.test(method)) {
      const argsList = (call.args && typeof call.args.toArray === 'function')
        ? call.args.toArray()
        : (call.args || []);
      const thresholdRaw = call.args && call.args.threshold !== undefined
        ? call.args.threshold
        : argsList[0];
      const otherSignatoriesRaw = call.args && (
        call.args.otherSignatories !== undefined || call.args.other_signatories !== undefined
      )
        ? (call.args.otherSignatories || call.args.other_signatories)
        : argsList[1];
      let innerCall = call.args && call.args.call !== undefined ? call.args.call : argsList[3];

      if (innerCall && typeof innerCall.unwrap === 'function' && innerCall.isSome === true) {
        innerCall = innerCall.unwrap();
      }

      const threshold = thresholdRaw !== undefined && thresholdRaw !== null
        ? Number(thresholdRaw.toString())
        : null;
      const otherSignatories = otherSignatoriesRaw && typeof otherSignatoriesRaw.toArray === 'function'
        ? otherSignatoriesRaw.toArray().map(address => address.toString())
        : Array.isArray(otherSignatoriesRaw)
          ? otherSignatoriesRaw.map(address => address.toString())
          : [];

      if (innerCall && typeof innerCall.section === 'string' && typeof innerCall.method === 'string') {
        return recurse(innerCall, `${currentPath}.m`, currentSigner, [
          ...wrappers,
          { section: 'multisig', method, threshold, otherSignatories }
        ]);
      }
    }

    if (section === 'sudo' && /^(sudo|sudoUncheckedWeight|sudo_unchecked_weight)$/i.test(method)) {
      const argsList = call.args && typeof call.args.toArray === 'function'
        ? call.args.toArray()
        : (call.args || []);
      const innerCall = argsList[0];
      if (innerCall && typeof innerCall.section === 'string' && typeof innerCall.method === 'string') {
        return recurse(innerCall, `${currentPath}.s`, currentSigner, [
          ...wrappers,
          { section: 'sudo', method }
        ]);
      }
    }

    const args = {};
    const argsArray = (call.args && typeof call.args.toArray === 'function') ? call.args.toArray() : (call.args || []);
    for (let i = 0; i < argsArray.length; i++) {
      args[i] = argsArray[i];
    }
    if (call.meta && call.meta.args) {
      const metaArgs = (call.meta.args && typeof call.meta.args.toArray === 'function') ? call.meta.args.toArray() : (call.meta.args || []);
      for (let i = 0; i < metaArgs.length; i++) {
        const argMeta = metaArgs[i];
        const name = argMeta.name.toString();
        args[name] = argsArray[i];
      }
    }

    return [{
      section,
      callName: method,
      signer: currentSigner,
      txHash,
      callPath: currentPath,
      args,
      tipTao,
      nonce,
      wrappers
    }];
  }

  return recurse(ext.method);
}

function getCallKey(parsed) {
  let netuid = 'none';
  if (parsed.args) {
    if (parsed.args.netuid !== undefined) {
      netuid = parsed.args.netuid.toString();
    } else if (parsed.args.destination_netuid !== undefined) {
      netuid = parsed.args.destination_netuid.toString();
    } else if (parsed.args[1] !== undefined) {
      netuid = parsed.args[1].toString();
    } else if (parsed.args[0] !== undefined && /^(startCall|start_call)$/i.test(parsed.callName)) {
      netuid = parsed.args[0].toString();
    }
  }
  const callPath = parsed.callPath || '0';
  return `${parsed.txHash}:${callPath}:${parsed.section}:${parsed.callName}:${netuid}`;
}

function decodeSubtensorEvent(event, blockNumber = null, extrinsicIndex = null) {
  const section = String(event.section || '').trim();
  const method = String(event.method || '').trim();
  const data = event.data || [];

  const result = {
    type: 'UNKNOWN',
    section,
    method,
    blockNumber,
    txIndex: extrinsicIndex,
    netuid: null,
    coldkey: null,
    hotkey: null,
    amountRao: null,
    amountTao: null,
    activationBlock: null,
    subnetName: null,
    swapColdkeyHash: null,
    enabled: null
  };

  if (section !== 'subtensorModule' && section !== 'adminUtils' && section !== 'admin_utils') {
    return result;
  }

  if ((section === 'adminUtils' || section === 'admin_utils') && method === 'SubnetEmissionEnabledSet') {
    result.type = 'SUBNET_EMISSION_ENABLED_SET';
    result.netuid = data[0] !== undefined && data[0] !== null
      ? Number(data[0].toString().replace(/,/g, ''))
      : null;
    const enabled = data[1]?.toString().toLowerCase();
    result.enabled = enabled === 'true' ? true : enabled === 'false' ? false : null;
    return result;
  }

  // 1. NetworkAdded
  if (method === 'NetworkAdded') {
    result.type = 'NETWORK_ADDED';
    const netuidRaw = data[0];
    result.netuid = netuidRaw ? Number(netuidRaw.toString().replace(/,/g, '')) : null;
  }

  // 2. SubnetIdentitySet
  else if (method === 'SubnetIdentitySet') {
    result.type = 'SUBNET_IDENTITY_SET';
    const netuidRaw = data[0];
    result.netuid = netuidRaw ? Number(netuidRaw.toString().replace(/,/g, '')) : null;
  }

  // 3. ColdkeySwapAnnounced
  else if (method === 'ColdkeySwapAnnounced') {
    result.type = 'COLDKEY_SWAP_ANNOUNCED';
    result.coldkey = data[0] ? data[0].toString() : null;
    result.swapColdkeyHash = data[1] ? data[1].toString() : null;
  }

  // 4. FirstEmissionBlockNumberSet
  else if (method === 'FirstEmissionBlockNumberSet') {
    result.type = 'FIRST_EMISSION_BLOCK_SET';
    result.netuid = data[0] ? Number(data[0].toString().replace(/,/g, '')) : null;
    const blockNumRaw = data[1] ? data[1].toString().replace(/,/g, '') : null;
    result.activationBlock = blockNumRaw ? Number(blockNumRaw) : null;
  }

  // 5. StakeAdded
  else if (method === 'StakeAdded') {
    result.type = 'STAKE_ADDED';
    result.coldkey = data[0] ? data[0].toString() : null;
    result.hotkey = data[1] ? data[1].toString() : null;
    
    const raoRaw = data[2] ? data[2].toString().replace(/,/g, '') : '0';
    result.amountRao = BigInt(raoRaw);
    result.amountTao = Number(result.amountRao) / 1e9;

    // data[4] is netuid
    const netuidRaw = data[4];
    result.netuid = netuidRaw ? Number(netuidRaw.toString().replace(/,/g, '')) : null;
  }

  return result;
}

module.exports = {
  codecToSortableBigInt,
  extractSubtensorCalls,
  getCallKey,
  decodeSubtensorEvent
};
