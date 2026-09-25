// @nightfleet/wallet - error taxonomy.
//
// The DApp Connector throws a plain object shaped like `APIError`:
//   { type: 'DAppConnectorAPIError', code, reason, message }
// (verified against @midnight-ntwrk/dapp-connector-api 4.0.1 dist/errors.d.ts;
// the 3.x line throws a CustomError subclass with the same `code`/`reason`).
// We never let those raw strings reach the UI: `userMessage` is derived purely
// from our own code, so wallet-supplied text cannot leak into the DOM or logs.

/** Error codes emitted by this package. Stable; the UI may switch on them. */
export const WalletErrorCode = Object.freeze({
  /** No Midnight DApp connector is injected on `window.midnight`. */
  NO_PROVIDER: 'NO_PROVIDER',
  /** A connector is injected but reports an `apiVersion` we do not support. */
  UNSUPPORTED_API_VERSION: 'UNSUPPORTED_API_VERSION',
  /** The user dismissed or rejected the authorization prompt. */
  USER_REJECTED: 'USER_REJECTED',
  /** The wallet refused a permission (not necessarily a user action). */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Heuristic: the wallet appears to be locked. See `isLockedReason`. */
  WALLET_LOCKED: 'WALLET_LOCKED',
  /** Connected, but to a network that is not the expected one. */
  WRONG_NETWORK: 'WRONG_NETWORK',
  /** Connected to mainnet. NightFleet is Preprod-only; we refuse, loudly. */
  MAINNET_REFUSED: 'MAINNET_REFUSED',
  /** We could not determine the network at all -> fail closed, never assume. */
  NETWORK_UNVERIFIED: 'NETWORK_UNVERIFIED',
  /** The wallet dropped the session after we were connected. */
  DISCONNECTED: 'DISCONNECTED',
  /** The wallet did not answer in time (Preprod sync is known to hang). */
  TIMEOUT: 'TIMEOUT',
  /** A signing-surface call was made while not connected. */
  NOT_CONNECTED: 'NOT_CONNECTED',
  /** The wallet rejected the request as malformed. */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** The connected wallet does not implement the method we need. */
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  /** Anything else the connector threw. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/**
 * UI copy per code. Fixed strings only - never interpolated with data that
 * came from the wallet, so there is no path from wallet state into the UI.
 * @type {Readonly<Record<string, { userMessage: string, action: string, retryable: boolean }>>}
 */
export const WALLET_ERROR_COPY = Object.freeze({
  [WalletErrorCode.NO_PROVIDER]: {
    userMessage: 'No Midnight wallet found in this browser.',
    action: 'Install the Lace wallet extension, then reload this page.',
    retryable: true,
  },
  [WalletErrorCode.UNSUPPORTED_API_VERSION]: {
    userMessage: 'This wallet speaks a DApp connector version NightFleet does not support.',
    action: 'Update the Lace extension to a current release.',
    retryable: false,
  },
  [WalletErrorCode.USER_REJECTED]: {
    userMessage: 'You declined the connection request.',
    action: 'Press Connect again and approve the prompt in Lace.',
    retryable: true,
  },
  [WalletErrorCode.PERMISSION_DENIED]: {
    userMessage: 'The wallet denied permission for this request.',
    action: 'Check NightFleet in the wallet’s connected-sites settings.',
    retryable: true,
  },
  [WalletErrorCode.WALLET_LOCKED]: {
    userMessage: 'Your wallet is locked.',
    action: 'Unlock Lace, then press Connect again.',
    retryable: true,
  },
  [WalletErrorCode.WRONG_NETWORK]: {
    userMessage: 'Your wallet is on the wrong Midnight network.',
    action: 'Switch Lace to Preprod, then press Connect again.',
    retryable: true,
  },
  [WalletErrorCode.MAINNET_REFUSED]: {
    userMessage: 'Your wallet is on mainnet. NightFleet never runs on mainnet.',
    action: 'Switch Lace to Preprod. NightFleet uses test funds only.',
    retryable: true,
  },
  [WalletErrorCode.NETWORK_UNVERIFIED]: {
    userMessage: 'NightFleet could not confirm which network this wallet is on.',
    action: 'Update Lace, or switch it to Preprod and try again.',
    retryable: true,
  },
  [WalletErrorCode.DISCONNECTED]: {
    userMessage: 'The wallet connection was lost.',
    action: 'Press Connect to reconnect.',
    retryable: true,
  },
  [WalletErrorCode.TIMEOUT]: {
    userMessage: 'The wallet did not respond in time.',
    action: 'Make sure Lace is open and unlocked, then try again.',
    retryable: true,
  },
  [WalletErrorCode.NOT_CONNECTED]: {
    userMessage: 'No wallet is connected.',
    action: 'Connect a wallet before signing or submitting.',
    retryable: true,
  },
  [WalletErrorCode.INVALID_REQUEST]: {
    userMessage: 'The wallet rejected that request.',
    action: 'This is a NightFleet bug - please report it.',
    retryable: false,
  },
  [WalletErrorCode.UNSUPPORTED_OPERATION]: {
    userMessage: 'This wallet cannot perform that operation.',
    action: 'Update the Lace extension to a current release.',
    retryable: false,
  },
  [WalletErrorCode.INTERNAL_ERROR]: {
    userMessage: 'The wallet reported an internal error.',
    action: 'Try again; if it persists, restart the extension.',
    retryable: true,
  },
});

/** Error thrown by every public method of this package. */
export class WalletError extends Error {
  /**
   * @param {string} code one of {@link WalletErrorCode}
   * @param {{ detail?: string, cause?: unknown }} [opts] `detail` is for
   *   developers (console/tests) and is never surfaced as `userMessage`.
   */
  constructor(code, opts = {}) {
    const copy = WALLET_ERROR_COPY[code] ?? WALLET_ERROR_COPY[WalletErrorCode.INTERNAL_ERROR];
    super(opts.detail ? `${code}: ${opts.detail}` : code);
    this.name = 'WalletError';
    this.code = code;
    this.userMessage = copy.userMessage;
    this.action = copy.action;
    this.retryable = copy.retryable;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  /** Plain, UI-safe shape. Contains no wallet-supplied text. */
  toJSON() {
    return {
      code: this.code,
      userMessage: this.userMessage,
      action: this.action,
      retryable: this.retryable,
    };
  }
}

/** True when `e` is the connector's documented error shape (either major). */
export function isConnectorError(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.type === 'DAppConnectorAPIError') return true;
  // 3.x threw a class instance; duck-type on the documented fields.
  return typeof e.code === 'string' && typeof e.reason === 'string';
}

/** Heuristic only: the connector has no dedicated "locked" code. */
export function isLockedReason(reason) {
  return typeof reason === 'string' && /\block(ed)?\b|unlock/i.test(reason);
}

/**
 * Map anything thrown by the wallet onto a {@link WalletError}.
 * @param {unknown} e
 * @param {string} [fallback] code to use when nothing else matches
 */
export function normalizeError(e, fallback = WalletErrorCode.INTERNAL_ERROR) {
  if (e instanceof WalletError) return e;

  if (isConnectorError(e)) {
    const reason = typeof e.reason === 'string' ? e.reason : '';
    switch (e.code) {
      case 'Rejected':
        return new WalletError(
          isLockedReason(reason) ? WalletErrorCode.WALLET_LOCKED : WalletErrorCode.USER_REJECTED,
          { detail: reason, cause: e },
        );
      case 'PermissionRejected':
        return new WalletError(
          isLockedReason(reason) ? WalletErrorCode.WALLET_LOCKED : WalletErrorCode.PERMISSION_DENIED,
          { detail: reason, cause: e },
        );
      case 'Disconnected':
        return new WalletError(WalletErrorCode.DISCONNECTED, { detail: reason, cause: e });
      case 'InvalidRequest':
        return new WalletError(WalletErrorCode.INVALID_REQUEST, { detail: reason, cause: e });
      case 'InternalError':
        return new WalletError(WalletErrorCode.INTERNAL_ERROR, { detail: reason, cause: e });
      default:
        return new WalletError(fallback, { detail: reason, cause: e });
    }
  }

  const message = e instanceof Error ? e.message : String(e);
  if (isLockedReason(message)) {
    return new WalletError(WalletErrorCode.WALLET_LOCKED, { detail: message, cause: e });
  }
  return new WalletError(fallback, { detail: message, cause: e });
}

/**
 * Reject with {@link WalletErrorCode.TIMEOUT} if `promise` is too slow.
 * Preprod wallet sync is documented to hang, so every wallet call is bounded.
 */
export function withTimeout(promise, ms, detail) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new WalletError(WalletErrorCode.TIMEOUT, { detail }));
    }, ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
