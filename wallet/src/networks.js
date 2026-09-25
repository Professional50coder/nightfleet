// @nightfleet/wallet - network identity and the Preprod guard.
//
// docs/PLAN.md section 4: Preprod only. Never mainnet, never real money.
// A wrong-network *silent* failure is the classic demo-killer, so everything
// here fails closed: if we cannot prove the wallet is on the expected network,
// we refuse to report `connected`.
//
// SPEC-DERIVED (not runtime-verified): the literal network-id strings.
// @midnight-ntwrk/midnight-js-network-id 4.1.1 types `NetworkId` as a bare
// `string` - there is no enum to check against - and the connector README only
// documents 'mainnet' by name. 'preprod' comes from docs/07-BLOCKCHAIN-
// INTEGRATION.md section 5. If Lace reports something else on Preprod, change
// `expectedNetworkId` at the call site; nothing else needs to move.

export const NetworkId = Object.freeze({
  PREPROD: 'preprod',
  PREVIEW: 'preview',
  UNDEPLOYED: 'undeployed',
  MAINNET: 'mainnet',
});

/** The only network NightFleet plays on. */
export const DEFAULT_EXPECTED_NETWORK_ID = NetworkId.PREPROD;

/** Networks we allow a developer to point at explicitly (never mainnet). */
export const ALLOWED_EXPECTED_NETWORK_IDS = Object.freeze([
  NetworkId.PREPROD,
  NetworkId.PREVIEW,
  NetworkId.UNDEPLOYED,
]);

function canonical(id) {
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

/** Mainnet in any spelling we have seen. Matched before anything else. */
export function isMainnetId(id) {
  return /^main[-_]?net$/.test(canonical(id));
}

export function isPreprodId(id) {
  return /^pre[-_]?prod$/.test(canonical(id));
}

/**
 * Assert a configured `expectedNetworkId` is one NightFleet may target.
 * Guards against a build config that quietly points the game at mainnet.
 */
export function assertAllowedTarget(id) {
  const c = canonical(id);
  if (isMainnetId(c)) {
    throw new Error('NightFleet refuses to target mainnet (docs/PLAN.md: Preprod only)');
  }
  if (!c) throw new Error('expectedNetworkId must be a non-empty string');
  return c;
}

/**
 * @typedef {{ ok: true, networkId: string }
 *   | { ok: false, code: 'MAINNET_REFUSED'|'WRONG_NETWORK'|'NETWORK_UNVERIFIED', networkId: string|null }} NetworkCheck
 */

/**
 * Compare what the wallet reports against what we require.
 * @param {string|null|undefined} reported
 * @param {string} expected
 * @returns {NetworkCheck}
 */
export function checkNetwork(reported, expected) {
  const got = canonical(reported);
  const want = canonical(expected);
  if (!got) return { ok: false, code: 'NETWORK_UNVERIFIED', networkId: null };
  if (isMainnetId(got)) return { ok: false, code: 'MAINNET_REFUSED', networkId: got };
  if (got === want) return { ok: true, networkId: got };
  // Tolerate 'pre-prod' vs 'preprod' spelling, nothing looser than that.
  if (isPreprodId(got) && isPreprodId(want)) return { ok: true, networkId: got };
  return { ok: false, code: 'WRONG_NETWORK', networkId: got };
}

/**
 * Last-resort inference for connectors that do not report a network id
 * (the 3.x `serviceUriConfig()` has no `networkId` field). Reads the host
 * names the wallet is configured with.
 *
 * HEURISTIC. Returns null when it cannot tell, which the caller turns into
 * NETWORK_UNVERIFIED rather than a guess.
 *
 * @param {{ indexerUri?: string, substrateNodeUri?: string, indexerWsUri?: string }} config
 * @returns {string|null}
 */
export function inferNetworkIdFromUris(config) {
  const haystack = [config?.indexerUri, config?.indexerWsUri, config?.substrateNodeUri]
    .filter((s) => typeof s === 'string')
    .join(' ')
    .toLowerCase();
  if (!haystack) return null;
  if (/\bmain[-_.]?net\b/.test(haystack)) return NetworkId.MAINNET;
  if (/pre[-_.]?prod/.test(haystack)) return NetworkId.PREPROD;
  if (/preview/.test(haystack)) return NetworkId.PREVIEW;
  if (/(^|\W)(localhost|127\.0\.0\.1)(\W|$)/.test(haystack)) return NetworkId.UNDEPLOYED;
  return null;
}
