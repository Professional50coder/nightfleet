// @nightfleet/wallet - the connector.
//
// One object, one state machine, one snapshot. The UI subscribes and renders
// `snapshot.status`; the deploy/game layer asks for `getSigner()`.
//
// Invariants this file enforces:
//   1. `status === 'connected'` implies the network was verified as Preprod.
//   2. Raw addresses never appear in a snapshot, an event, or an error.
//   3. `getSigner()` throws unless invariant 1 holds.

import { WalletError, WalletErrorCode, normalizeError } from './errors.js';
import { WalletStatus, assertTransition } from './state.js';
import { detectWallets, pickWallet, assertUsable } from './detect.js';
import { openSession } from './adapter.js';
import {
  DEFAULT_EXPECTED_NETWORK_ID, assertAllowedTarget, checkNetwork,
} from './networks.js';
import { redactAddress, scrubForLog } from './redact.js';

const DEFAULTS = Object.freeze({
  expectedNetworkId: DEFAULT_EXPECTED_NETWORK_ID,
  timeoutMs: 60_000,
  watchIntervalMs: 10_000,
  addressKind: 'shielded',
  /** Trust a network id we only *inferred* from service URIs? Fail closed. */
  allowInferredNetwork: false,
});

/**
 * @typedef {object} WalletSnapshot
 * @property {import('./state.js').WalletStatus} status
 * @property {{ key: string, name: string, icon: string, rdns: string, apiVersion: string, flavor: string|null, isLace: boolean }|null} wallet
 *   `name`/`icon` are wallet-supplied: render as a text node / <img src> only.
 * @property {string|null} address     redacted for display, never raw
 * @property {string|null} networkId
 * @property {boolean} networkVerified
 * @property {boolean} networkInferred
 * @property {Readonly<Record<string, boolean>>|null} capabilities
 * @property {{ code: string, userMessage: string, action: string, retryable: boolean }|null} error
 * @property {number|null} connectedAt epoch ms
 */

const EMPTY_SNAPSHOT = Object.freeze({
  status: WalletStatus.UNAVAILABLE,
  wallet: null,
  address: null,
  networkId: null,
  networkVerified: false,
  networkInferred: false,
  capabilities: null,
  error: null,
  connectedAt: null,
});

export class LaceConnector {
  /**
   * @param {object} [options]
   * @param {string} [options.expectedNetworkId] default 'preprod'; mainnet is refused
   * @param {number} [options.timeoutMs] per wallet call
   * @param {number} [options.watchIntervalMs] mid-session liveness poll
   * @param {'shielded'|'unshielded'} [options.addressKind] which address to display
   * @param {string} [options.walletKey] pin an exact `window.midnight` key
   * @param {boolean} [options.allowInferredNetwork] accept a heuristic network id
   * @param {{lead?:number,tail?:number}} [options.redaction] display window
   * @param {(event: string, data: object) => void} [options.logger] receives scrubbed data only
   * @param {object} [options.window] injection point for tests
   */
  constructor(options = {}) {
    const o = { ...DEFAULTS, ...options };
    this.expectedNetworkId = assertAllowedTarget(o.expectedNetworkId);
    this.timeoutMs = o.timeoutMs;
    this.watchIntervalMs = o.watchIntervalMs;
    this.addressKind = o.addressKind;
    this.walletKey = o.walletKey;
    this.allowInferredNetwork = o.allowInferredNetwork;
    this.redaction = o.redaction ?? {};
    this._logger = typeof o.logger === 'function' ? o.logger : null;
    this._window = o.window ?? globalThis;

    /** @type {WalletSnapshot} */
    this._snapshot = EMPTY_SNAPSHOT;
    this._listeners = new Set();
    /** @type {import('./adapter.js').NormalizedSession|null} */
    this._session = null;
    this._inflight = null;
    this._watchHandle = null;
    this._destroyed = false;
  }

  // ---------------------------------------------------------------- reading

  /** Current state. Referentially stable until something actually changes. */
  getSnapshot() {
    return this._snapshot;
  }

  /**
   * @param {(s: WalletSnapshot) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  /** Every injected connector, for a wallet-picker UI. */
  listWallets() {
    return detectWallets(this._window).map(({ provider, ...rest }) => rest);
  }

  // ---------------------------------------------------------------- actions

  /**
   * Look for an injected connector and move to `available` / `unavailable`.
   * Safe to call on mount and on `window` focus. Never throws.
   * @returns {WalletSnapshot}
   */
  detect() {
    if (this._destroyed) return this._snapshot;
    if (this._snapshot.status === WalletStatus.CONNECTED
      || this._snapshot.status === WalletStatus.CONNECTING) {
      return this._snapshot;
    }
    const wallet = pickWallet(detectWallets(this._window), { walletKey: this.walletKey });
    if (!wallet || !wallet.supported) {
      return this._set(WalletStatus.UNAVAILABLE, {
        wallet: wallet ? publicWallet(wallet) : null,
        error: wallet
          ? errPayload(new WalletError(WalletErrorCode.UNSUPPORTED_API_VERSION))
          : null,
      });
    }
    return this._set(WalletStatus.AVAILABLE, { wallet: publicWallet(wallet), error: null });
  }

  /**
   * Request authorization, then verify the network before reporting success.
   *
   * Never rejects: every failure lands in `snapshot.error` with a stable code,
   * so the UI has one render path. Concurrent calls share one attempt.
   *
   * @returns {Promise<WalletSnapshot>}
   */
  connect() {
    if (this._destroyed) return Promise.resolve(this._snapshot);
    if (this._inflight) return this._inflight;
    if (this._snapshot.status === WalletStatus.CONNECTED) {
      return Promise.resolve(this._snapshot);
    }
    this._inflight = this._connect().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _connect() {
    const wallet = pickWallet(detectWallets(this._window), { walletKey: this.walletKey });
    try {
      assertUsable(wallet);
    } catch (e) {
      return this._fail(e, wallet ? publicWallet(wallet) : null);
    }

    // Walk the machine honestly: a provider exists, so we are `available`
    // before we are `connecting`, even when connect() was called cold.
    this._set(WalletStatus.AVAILABLE, { wallet: publicWallet(wallet), error: null });
    this._set(WalletStatus.CONNECTING, { wallet: publicWallet(wallet), error: null });
    this._log('connect:start', { wallet: wallet.key, apiVersion: wallet.apiVersion });

    let session;
    try {
      session = await openSession(wallet, {
        networkIdHint: this.expectedNetworkId,
        timeoutMs: this.timeoutMs,
        addressKind: this.addressKind,
      });
    } catch (e) {
      return this._fail(e, publicWallet(wallet));
    }

    // Tell the wallet up front which methods we intend to use, so it can
    // gather every permission in one prompt instead of interrupting mid-game.
    try {
      await session.hintUsage(hintsFor(session));
    } catch {
      // Advisory only: a wallet that refuses the hint can still be used.
    }

    // --- network gate: nothing below this line runs on the wrong chain -----
    let reported;
    try {
      reported = await session.getNetworkId();
    } catch (e) {
      return this._fail(e, publicWallet(wallet));
    }

    if (reported.inferred && !this.allowInferredNetwork) {
      return this._fail(
        new WalletError(WalletErrorCode.NETWORK_UNVERIFIED, {
          detail: `network id was only inferred (${reported.networkId}); set allowInferredNetwork to accept it`,
        }),
        publicWallet(wallet),
        { networkId: reported.networkId, networkInferred: true },
      );
    }

    const check = checkNetwork(reported.networkId, this.expectedNetworkId);
    if (!check.ok) {
      return this._fail(
        new WalletError(WalletErrorCode[check.code], {
          detail: `wallet reports network "${check.networkId ?? 'unknown'}", expected "${this.expectedNetworkId}"`,
        }),
        publicWallet(wallet),
        { networkId: check.networkId, networkInferred: reported.inferred },
      );
    }

    let address = '';
    try {
      address = await session.getRawAddress();
    } catch (e) {
      return this._fail(e, publicWallet(wallet));
    }

    this._session = session;
    this._startWatch();
    this._log('connect:ok', { wallet: wallet.key, networkId: check.networkId });

    return this._set(WalletStatus.CONNECTED, {
      wallet: publicWallet(wallet),
      address: redactAddress(address, this.redaction),
      networkId: check.networkId,
      networkVerified: true,
      networkInferred: reported.inferred,
      capabilities: session.capabilities,
      error: null,
      connectedAt: Date.now(),
    });
  }

  /**
   * Drop the session locally. The connector API has no "revoke"; the wallet
   * keeps its own permission record, so a later connect() may not re-prompt.
   * @returns {WalletSnapshot}
   */
  disconnect() {
    this._stopWatch();
    this._session = null;
    this._log('disconnect', {});
    const wallet = pickWallet(detectWallets(this._window), { walletKey: this.walletKey });
    const next = wallet && wallet.supported ? WalletStatus.AVAILABLE : WalletStatus.UNAVAILABLE;
    return this._set(next, {
      wallet: wallet ? publicWallet(wallet) : null,
      address: null,
      networkId: null,
      networkVerified: false,
      networkInferred: false,
      capabilities: null,
      error: null,
      connectedAt: null,
    });
  }

  /** Leave the error state without reconnecting (the UI's "dismiss"). */
  clearError() {
    if (this._snapshot.status !== WalletStatus.ERROR) return this._snapshot;
    return this.detect();
  }

  /**
   * One liveness poll. Call from a window-focus handler as well as the timer.
   * Moves `connected -> error(DISCONNECTED)` when the wallet dropped us.
   * @returns {Promise<WalletSnapshot>}
   */
  async checkConnection() {
    if (this._destroyed) return this._snapshot;
    if (this._snapshot.status !== WalletStatus.CONNECTED || !this._session) {
      return this._snapshot;
    }
    // The extension being disabled or removed outranks anything it told us.
    const wallet = pickWallet(detectWallets(this._window), { walletKey: this.walletKey });
    if (!wallet || !wallet.supported) {
      this._stopWatch();
      this._session = null;
      return this._set(WalletStatus.UNAVAILABLE, {
        ...clearedConnectionFields(),
        wallet: null,
        error: errPayload(new WalletError(WalletErrorCode.NO_PROVIDER, {
          detail: 'the connector disappeared from window.midnight mid-session',
        })),
      });
    }

    let status;
    try {
      status = await this._session.getConnectionStatus();
    } catch {
      status = 'unknown';
    }
    if (status === 'disconnected') {
      this._stopWatch();
      this._session = null;
      this._log('session:lost', {});
      return this._set(WalletStatus.ERROR, {
        ...clearedConnectionFields(),
        error: errPayload(new WalletError(WalletErrorCode.DISCONNECTED, {
          detail: 'wallet reported disconnected while the game was live',
        })),
      });
    }
    return this._snapshot;
  }

  // -------------------------------------------------------- signing surface

  /**
   * The narrow surface the deploy/game layer is allowed to touch.
   * Throws {@link WalletError} NOT_CONNECTED unless we are connected AND the
   * network was verified. Balances, dust and transaction history are
   * deliberately absent - NightFleet has no reason to read them.
   *
   * @returns {{
   *   networkId: string,
   *   capabilities: Readonly<Record<string, boolean>>,
   *   getServiceConfig: () => Promise<object>,
   *   signData: (data: string, options: object) => Promise<object>,
   *   balanceTransaction: (tx: unknown, options?: object) => Promise<unknown>,
   *   submitTransaction: (tx: unknown) => Promise<unknown>,
   *   getProvingProvider: (keyMaterialProvider: object) => Promise<object>,
   * }}
   */
  getSigner() {
    const s = this._session;
    if (!s || this._snapshot.status !== WalletStatus.CONNECTED || !this._snapshot.networkVerified) {
      throw new WalletError(WalletErrorCode.NOT_CONNECTED, {
        detail: `getSigner() called while status="${this._snapshot.status}"`,
      });
    }
    return Object.freeze({
      networkId: this._snapshot.networkId,
      capabilities: s.capabilities,
      getServiceConfig: () => s.getServiceConfig(),
      signData: (data, options) => s.signData(data, options),
      balanceTransaction: (tx, options) => s.balanceTransaction(tx, options),
      submitTransaction: (tx) => s.submitTransaction(tx),
      getProvingProvider: (kmp) => s.getProvingProvider(kmp),
    });
  }

  /**
   * The raw, unredacted address. Deliberately awkward: explorer deep-links and
   * clipboard copy are the only legitimate callers. Never log the result, and
   * never put it in a snapshot.
   * @returns {Promise<string>}
   */
  async revealAddress() {
    if (!this._session || this._snapshot.status !== WalletStatus.CONNECTED) {
      throw new WalletError(WalletErrorCode.NOT_CONNECTED, {
        detail: 'revealAddress() called while not connected',
      });
    }
    return this._session.getRawAddress();
  }

  // ---------------------------------------------------------------- teardown

  destroy() {
    this._stopWatch();
    this._destroyed = true;
    this._session = null;
    this._listeners.clear();
  }

  // ---------------------------------------------------------------- internal

  _startWatch() {
    this._stopWatch();
    if (!(this.watchIntervalMs > 0)) return;
    const setter = this._window?.setInterval ?? setInterval;
    this._watchHandle = setter.call(this._window ?? globalThis, () => {
      void this.checkConnection();
    }, this.watchIntervalMs);
    // Do not hold a Node process open on account of a liveness poll.
    if (this._watchHandle && typeof this._watchHandle.unref === 'function') {
      this._watchHandle.unref();
    }
  }

  _stopWatch() {
    if (this._watchHandle === null) return;
    const clearer = this._window?.clearInterval ?? clearInterval;
    clearer.call(this._window ?? globalThis, this._watchHandle);
    this._watchHandle = null;
  }

  /** Move to `error`, recording a UI-safe payload. Never rejects. */
  _fail(e, wallet, extra = {}) {
    const err = normalizeError(e);
    this._session = null;
    this._stopWatch();
    this._log('connect:error', { code: err.code });
    return this._set(WalletStatus.ERROR, {
      ...clearedConnectionFields(),
      wallet: wallet ?? this._snapshot.wallet,
      ...extra,
      error: errPayload(err),
    });
  }

  /** Apply a transition and notify subscribers if anything actually changed. */
  _set(status, patch) {
    assertTransition(this._snapshot.status, status);
    const next = Object.freeze({ ...this._snapshot, ...patch, status });
    if (shallowEqual(next, this._snapshot)) return this._snapshot;
    this._snapshot = next;
    for (const l of [...this._listeners]) {
      try {
        l(next);
      } catch {
        // A broken subscriber must not break the state machine.
      }
    }
    return next;
  }

  /** All logger output passes through the scrubber. No exceptions. */
  _log(event, data) {
    if (!this._logger) return;
    try {
      this._logger(event, scrubForLog(data));
    } catch {
      // Logging is never allowed to fail a connection.
    }
  }
}

/** Factory mirroring the rest of the repo's `create*` style. */
export function createLaceConnector(options) {
  return new LaceConnector(options);
}

/**
 * `{ subscribe, getSnapshot }` for React's `useSyncExternalStore` (or any
 * other observer). Kept in the core so the React entry point stays trivial.
 */
export function createWalletStore(connector) {
  return Object.freeze({
    subscribe: (cb) => connector.subscribe(cb),
    getSnapshot: () => connector.getSnapshot(),
    getServerSnapshot: () => EMPTY_SNAPSHOT,
  });
}

export { EMPTY_SNAPSHOT };

// ------------------------------------------------------------------ helpers

function publicWallet(w) {
  return w && Object.freeze({
    key: w.key,
    name: w.name,
    icon: w.icon,
    rdns: w.rdns,
    apiVersion: w.apiVersion,
    flavor: w.flavor,
    isLace: w.isLace,
  });
}

function errPayload(err) {
  return Object.freeze(err.toJSON());
}

function clearedConnectionFields() {
  return {
    address: null,
    networkId: null,
    networkVerified: false,
    networkInferred: false,
    capabilities: null,
    connectedAt: null,
  };
}

/** Methods we will use, declared up front so Lace can batch its prompts. */
function hintsFor(session) {
  const names = [];
  if (session.capabilities.serviceConfig) names.push('getConfiguration');
  if (session.capabilities.connectionStatus) names.push('getConnectionStatus');
  names.push('getShieldedAddresses');
  if (session.capabilities.balanceTransaction) names.push('balanceUnsealedTransaction');
  if (session.capabilities.submitTransaction) names.push('submitTransaction');
  if (session.capabilities.provingProvider) names.push('getProvingProvider');
  if (session.capabilities.signData) names.push('signData');
  return names;
}

/**
 * Snapshot equality. `wallet` and `error` are rebuilt on every pass, so they
 * are compared by value - otherwise `detect()` on every window focus would
 * push a new object at React and re-render the whole board for nothing.
 */
function shallowEqual(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => {
    if (k === 'wallet' || k === 'error') return sameFields(a[k], b[k]);
    return a[k] === b[k];
  });
}

function sameFields(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}
