// @nightfleet/wallet - provider detection + API-version gate.
//
// RUNTIME-VERIFIED against the published type definitions of
// @midnight-ntwrk/dapp-connector-api (4.0.1 and 3.0.0), read from npm:
//
//   4.x  window.midnight[walletKey] : InitialAPI
//        { rdns, name, icon, apiVersion, connect(networkId) -> ConnectedAPI }
//
//   3.x  window.midnight[walletKey] : DAppConnectorAPI
//        { name, apiVersion, isEnabled(), serviceUriConfig(), enable() }
//
// NOT verified: which of these two a shipping Lace build actually injects, and
// under which key. The docs name `window.midnight.mnLace`; we accept any key
// and rank Lace-looking ones first rather than hard-coding one.

import { WalletError, WalletErrorCode } from './errors.js';

/** Keys/rdns we treat as "this is Lace" when several wallets are injected. */
export const LACE_HINTS = Object.freeze(['mnlace', 'lace', 'io.lace', 'com.lace']);

/** DApp connector majors this package knows how to drive. */
export const SUPPORTED_API_MAJORS = Object.freeze([4, 3]);

/** Preferred major when a wallet injects more than one instance. */
export const PREFERRED_API_MAJOR = 4;

/**
 * Parse the leading integer of a semver string.
 * @returns {number|null}
 */
export function parseApiMajor(apiVersion) {
  if (typeof apiVersion !== 'string') return null;
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(apiVersion);
  return m ? Number(m[1]) : null;
}

/** Which flavour of the connector API this instance speaks. */
export function detectFlavor(provider) {
  if (!provider || typeof provider !== 'object') return null;
  if (typeof provider.connect === 'function') return 'v4';
  if (typeof provider.enable === 'function') return 'v3';
  return null;
}

/**
 * @typedef {object} DetectedWallet
 * @property {string} key       the `window.midnight` property name
 * @property {string} name      wallet-supplied display name (UNSANITIZED)
 * @property {string} icon      wallet-supplied icon URL (UNSANITIZED)
 * @property {string} rdns      reverse-DNS id, '' on 3.x
 * @property {string} apiVersion
 * @property {number|null} apiMajor
 * @property {'v4'|'v3'|null} flavor
 * @property {boolean} supported
 * @property {boolean} isLace
 * @property {object} provider  the raw injected object
 */

/**
 * Enumerate every Midnight connector injected on `win`.
 * Never throws: a hostile or half-initialised injection yields `supported:false`.
 *
 * `name` and `icon` come straight from the extension. The connector spec is
 * explicit that DApps must treat them as untrusted: render `name` as a text
 * node and `icon` only via an <img> src. We pass them through unchanged and
 * say so rather than pretending they are safe.
 *
 * @param {{ midnight?: Record<string, unknown> }} [win]
 * @returns {DetectedWallet[]}
 */
export function detectWallets(win = globalThis) {
  const registry = win && typeof win === 'object' ? win.midnight : undefined;
  if (!registry || typeof registry !== 'object') return [];

  const found = [];
  for (const key of Object.keys(registry)) {
    let provider;
    try {
      provider = registry[key];
    } catch {
      continue; // a throwing getter is not a wallet we can use
    }
    if (!provider || typeof provider !== 'object') continue;

    const flavor = detectFlavor(provider);
    const apiVersion = typeof provider.apiVersion === 'string' ? provider.apiVersion : '';
    const apiMajor = parseApiMajor(apiVersion);
    const rdns = typeof provider.rdns === 'string' ? provider.rdns : '';
    const hay = `${key} ${rdns}`.toLowerCase();

    found.push({
      key,
      name: typeof provider.name === 'string' ? provider.name : key,
      icon: typeof provider.icon === 'string' ? provider.icon : '',
      rdns,
      apiVersion,
      apiMajor,
      flavor,
      supported: flavor !== null && apiMajor !== null && SUPPORTED_API_MAJORS.includes(apiMajor),
      isLace: LACE_HINTS.some((h) => hay.includes(h)),
      provider,
    });
  }
  return found;
}

/**
 * Choose which injected wallet to drive.
 * Order: supported first, then Lace, then the preferred API major, then key
 * order (stable, so repeated detection does not flip the selection).
 *
 * @param {DetectedWallet[]} wallets
 * @param {{ walletKey?: string }} [opts] pin an exact `window.midnight` key
 * @returns {DetectedWallet|null}
 */
export function pickWallet(wallets, opts = {}) {
  if (!Array.isArray(wallets) || wallets.length === 0) return null;
  if (opts.walletKey) {
    return wallets.find((w) => w.key === opts.walletKey) ?? null;
  }
  const ranked = [...wallets].sort((a, b) => {
    if (a.supported !== b.supported) return a.supported ? -1 : 1;
    if (a.isLace !== b.isLace) return a.isLace ? -1 : 1;
    const am = a.apiMajor === PREFERRED_API_MAJOR ? 0 : 1;
    const bm = b.apiMajor === PREFERRED_API_MAJOR ? 0 : 1;
    if (am !== bm) return am - bm;
    return 0;
  });
  return ranked[0];
}

/**
 * Throw a precise {@link WalletError} explaining why `wallet` is unusable.
 * Returns the wallet untouched when it is fine.
 */
export function assertUsable(wallet) {
  if (!wallet) {
    throw new WalletError(WalletErrorCode.NO_PROVIDER, {
      detail: 'window.midnight is empty or absent',
    });
  }
  if (wallet.flavor === null) {
    throw new WalletError(WalletErrorCode.UNSUPPORTED_API_VERSION, {
      detail: `injected object at window.midnight.${wallet.key} has neither connect() nor enable()`,
    });
  }
  if (wallet.apiMajor === null) {
    throw new WalletError(WalletErrorCode.UNSUPPORTED_API_VERSION, {
      detail: `window.midnight.${wallet.key} reported a non-semver apiVersion`,
    });
  }
  if (!SUPPORTED_API_MAJORS.includes(wallet.apiMajor)) {
    throw new WalletError(WalletErrorCode.UNSUPPORTED_API_VERSION, {
      detail: `connector API major ${wallet.apiMajor}; supported: ${SUPPORTED_API_MAJORS.join(', ')}`,
    });
  }
  return wallet;
}
