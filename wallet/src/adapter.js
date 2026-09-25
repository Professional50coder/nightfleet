// @nightfleet/wallet - normalise the two connector majors into one session.
//
// Everything above this file speaks `NormalizedSession` and never touches the
// injected object again. When Lace changes, this is the only file that moves.
//
// The surface deliberately stops at what docs/07 + docs/11 need: identity for
// display, network for verification, and a signing/submit path. Balances, dust,
// and transaction history are reachable on the raw connector and are NOT
// forwarded - the game has no business reading them.

import { WalletError, WalletErrorCode, normalizeError, withTimeout } from './errors.js';
import { inferNetworkIdFromUris } from './networks.js';

/**
 * @typedef {object} NormalizedSession
 * @property {'v4'|'v3'} flavor
 * @property {Readonly<Record<string, boolean>>} capabilities
 * @property {() => Promise<object>} getServiceConfig
 * @property {() => Promise<{ networkId: string|null, inferred: boolean }>} getNetworkId
 * @property {() => Promise<string>} getRawAddress  raw bech32m - callers must redact
 * @property {() => Promise<'connected'|'disconnected'|'unknown'>} getConnectionStatus
 * @property {(data: string, options: object) => Promise<object>} signData
 * @property {(tx: unknown, options?: object) => Promise<unknown>} balanceTransaction
 * @property {(tx: unknown) => Promise<unknown>} submitTransaction
 * @property {(keyMaterialProvider: object) => Promise<object>} getProvingProvider
 * @property {(methods: string[]) => Promise<void>} hintUsage
 */

function unsupported(op, flavor) {
  return () => Promise.reject(new WalletError(WalletErrorCode.UNSUPPORTED_OPERATION, {
    detail: `${op}() is not available on DApp connector API ${flavor}`,
  }));
}

/**
 * Open a session against a detected wallet.
 *
 * @param {import('./detect.js').DetectedWallet} wallet
 * @param {{ networkIdHint: string, timeoutMs: number, addressKind?: 'shielded'|'unshielded' }} opts
 * @returns {Promise<NormalizedSession>}
 */
export async function openSession(wallet, opts) {
  const { networkIdHint, timeoutMs, addressKind = 'shielded' } = opts;
  try {
    if (wallet.flavor === 'v4') {
      // InitialAPI.connect(networkId) -> ConnectedAPI. The id is a *hint*; the
      // wallet may ignore it, which is exactly why we verify afterwards.
      const api = await withTimeout(
        wallet.provider.connect(networkIdHint),
        timeoutMs,
        'connect() did not resolve',
      );
      if (!api || typeof api !== 'object') {
        throw new WalletError(WalletErrorCode.INTERNAL_ERROR, {
          detail: 'connect() resolved with a non-object',
        });
      }
      return makeV4Session(api, { timeoutMs, addressKind });
    }
    const api = await withTimeout(
      wallet.provider.enable(),
      timeoutMs,
      'enable() did not resolve',
    );
    if (!api || typeof api !== 'object') {
      throw new WalletError(WalletErrorCode.INTERNAL_ERROR, {
        detail: 'enable() resolved with a non-object',
      });
    }
    return makeV3Session(api, wallet.provider, { timeoutMs });
  } catch (e) {
    throw normalizeError(e, WalletErrorCode.INTERNAL_ERROR);
  }
}

/** @returns {NormalizedSession} */
function makeV4Session(api, { timeoutMs, addressKind }) {
  const call = (fn, label) => withTimeout(Promise.resolve().then(fn), timeoutMs, label)
    .catch((e) => { throw normalizeError(e); });

  const capabilities = Object.freeze({
    signData: typeof api.signData === 'function',
    balanceTransaction: typeof api.balanceUnsealedTransaction === 'function',
    submitTransaction: typeof api.submitTransaction === 'function',
    provingProvider: typeof api.getProvingProvider === 'function',
    serviceConfig: typeof api.getConfiguration === 'function',
    connectionStatus: typeof api.getConnectionStatus === 'function',
    hintUsage: typeof api.hintUsage === 'function',
  });

  return {
    flavor: 'v4',
    capabilities,

    getServiceConfig: () => call(() => api.getConfiguration(), 'getConfiguration()'),

    async getNetworkId() {
      // Two independent sources; prefer the connection status because it is
      // what the wallet believes *right now*.
      if (capabilities.connectionStatus) {
        const status = await call(() => api.getConnectionStatus(), 'getConnectionStatus()');
        if (status?.status === 'disconnected') {
          throw new WalletError(WalletErrorCode.DISCONNECTED, {
            detail: 'getConnectionStatus() reported disconnected during network check',
          });
        }
        if (typeof status?.networkId === 'string' && status.networkId) {
          return { networkId: status.networkId, inferred: false };
        }
      }
      if (capabilities.serviceConfig) {
        const cfg = await call(() => api.getConfiguration(), 'getConfiguration()');
        if (typeof cfg?.networkId === 'string' && cfg.networkId) {
          return { networkId: cfg.networkId, inferred: false };
        }
        const guess = inferNetworkIdFromUris(cfg ?? {});
        if (guess) return { networkId: guess, inferred: true };
      }
      return { networkId: null, inferred: false };
    },

    async getRawAddress() {
      if (addressKind === 'unshielded') {
        const r = await call(() => api.getUnshieldedAddress(), 'getUnshieldedAddress()');
        return typeof r?.unshieldedAddress === 'string' ? r.unshieldedAddress : '';
      }
      const r = await call(() => api.getShieldedAddresses(), 'getShieldedAddresses()');
      return typeof r?.shieldedAddress === 'string' ? r.shieldedAddress : '';
    },

    async getConnectionStatus() {
      if (!capabilities.connectionStatus) return 'unknown';
      try {
        const s = await call(() => api.getConnectionStatus(), 'getConnectionStatus()');
        return s?.status === 'connected' ? 'connected'
          : s?.status === 'disconnected' ? 'disconnected'
            : 'unknown';
      } catch (e) {
        if (e instanceof WalletError && e.code === WalletErrorCode.DISCONNECTED) return 'disconnected';
        return 'unknown';
      }
    },

    signData: capabilities.signData
      ? (data, options) => call(() => api.signData(data, options), 'signData()')
      : unsupported('signData', 'v4'),

    // A contract call produces an unsealed transaction, so this is the right
    // entry point per the connector README; `sealed: true` opts into the other.
    balanceTransaction: capabilities.balanceTransaction
      ? (tx, options = {}) => {
        const { sealed = false, ...rest } = options;
        return call(() => (sealed
          ? api.balanceSealedTransaction(tx, rest)
          : api.balanceUnsealedTransaction(tx, rest)), 'balanceTransaction()');
      }
      : unsupported('balanceTransaction', 'v4'),

    submitTransaction: capabilities.submitTransaction
      ? (tx) => call(() => api.submitTransaction(tx), 'submitTransaction()')
      : unsupported('submitTransaction', 'v4'),

    // The Lace-side proof provider: docs/07 section 2 wants this as the
    // fallback when the local HTTP proof server errors.
    getProvingProvider: capabilities.provingProvider
      ? (kmp) => call(() => api.getProvingProvider(kmp), 'getProvingProvider()')
      : unsupported('getProvingProvider', 'v4'),

    hintUsage: capabilities.hintUsage
      ? (methods) => call(() => api.hintUsage(methods), 'hintUsage()')
      : () => Promise.resolve(),
  };
}

/** @returns {NormalizedSession} */
function makeV3Session(api, provider, { timeoutMs }) {
  const call = (fn, label) => withTimeout(Promise.resolve().then(fn), timeoutMs, label)
    .catch((e) => { throw normalizeError(e); });

  const capabilities = Object.freeze({
    signData: false, // 3.x has no signData
    balanceTransaction: typeof api.balanceAndProveTransaction === 'function',
    submitTransaction: typeof api.submitTransaction === 'function',
    provingProvider: false, // 3.x proves inside balanceAndProveTransaction
    serviceConfig: typeof provider.serviceUriConfig === 'function',
    connectionStatus: typeof provider.isEnabled === 'function',
    hintUsage: false,
  });

  return {
    flavor: 'v3',
    capabilities,

    getServiceConfig: capabilities.serviceConfig
      ? () => call(() => provider.serviceUriConfig(), 'serviceUriConfig()')
      : unsupported('getServiceConfig', 'v3'),

    async getNetworkId() {
      // 3.x reports no network id at all. Infer from the configured hosts and
      // mark it inferred so the connector can decide how much to trust it.
      if (!capabilities.serviceConfig) return { networkId: null, inferred: false };
      const cfg = await call(() => provider.serviceUriConfig(), 'serviceUriConfig()');
      const guess = inferNetworkIdFromUris(cfg ?? {});
      return guess ? { networkId: guess, inferred: true } : { networkId: null, inferred: false };
    },

    async getRawAddress() {
      const s = await call(() => api.state(), 'state()');
      return typeof s?.address === 'string' ? s.address : '';
    },

    async getConnectionStatus() {
      if (!capabilities.connectionStatus) return 'unknown';
      try {
        const enabled = await call(() => provider.isEnabled(), 'isEnabled()');
        return enabled ? 'connected' : 'disconnected';
      } catch {
        return 'unknown';
      }
    },

    signData: unsupported('signData', 'v3'),

    balanceTransaction: capabilities.balanceTransaction
      ? (tx, options = {}) => call(
        () => api.balanceAndProveTransaction(tx, options.newCoins ?? []),
        'balanceAndProveTransaction()',
      )
      : unsupported('balanceTransaction', 'v3'),

    submitTransaction: capabilities.submitTransaction
      ? (tx) => call(() => api.submitTransaction(tx), 'submitTransaction()')
      : unsupported('submitTransaction', 'v3'),

    getProvingProvider: unsupported('getProvingProvider', 'v3'),

    hintUsage: () => Promise.resolve(),
  };
}
