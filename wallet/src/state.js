// @nightfleet/wallet - the connection state machine.
//
// Five states, one legal-transition table. The UI renders `status` directly;
// it never has to reconcile a bag of booleans.
//
//                    detect()                connect()
//   unavailable ---------------> available -------------> connecting
//        ^                          ^   ^                   |     |
//        |  provider removed        |   | disconnect()      |     | failure
//        +--------------------------+   +-------------------+     v
//                                              connected <---  error
//                                                (success)

/** @typedef {'unavailable'|'available'|'connecting'|'connected'|'error'} WalletStatus */

export const WalletStatus = Object.freeze({
  /** No supported connector injected (extension missing or wrong version). */
  UNAVAILABLE: 'unavailable',
  /** A supported connector is present but we have not been authorized. */
  AVAILABLE: 'available',
  /** Authorization requested; the wallet prompt is (or should be) open. */
  CONNECTING: 'connecting',
  /** Authorized AND network-verified. Only here is the signing surface live. */
  CONNECTED: 'connected',
  /** Terminal-for-now failure; `error` carries a code the UI can render. */
  ERROR: 'error',
});

export const WALLET_STATUSES = Object.freeze(Object.values(WalletStatus));

/**
 * Legal transitions. Anything else is a bug in this package and throws.
 * @type {Readonly<Record<WalletStatus, readonly WalletStatus[]>>}
 */
export const TRANSITIONS = Object.freeze({
  [WalletStatus.UNAVAILABLE]: Object.freeze([
    WalletStatus.AVAILABLE, // provider appeared (late injection / page reload)
    WalletStatus.ERROR, // connect() called with nothing installed
  ]),
  [WalletStatus.AVAILABLE]: Object.freeze([
    WalletStatus.CONNECTING,
    WalletStatus.UNAVAILABLE, // extension removed / disabled mid-session
    WalletStatus.ERROR,
  ]),
  [WalletStatus.CONNECTING]: Object.freeze([
    WalletStatus.CONNECTED,
    WalletStatus.ERROR,
    WalletStatus.AVAILABLE, // disconnect() raced the prompt
    WalletStatus.UNAVAILABLE,
  ]),
  [WalletStatus.CONNECTED]: Object.freeze([
    WalletStatus.AVAILABLE, // user-initiated disconnect
    WalletStatus.ERROR, // wallet dropped us mid-session
    WalletStatus.UNAVAILABLE,
  ]),
  [WalletStatus.ERROR]: Object.freeze([
    WalletStatus.CONNECTING, // retry
    WalletStatus.AVAILABLE, // clearError()
    WalletStatus.UNAVAILABLE,
  ]),
});

export function isWalletStatus(s) {
  return WALLET_STATUSES.includes(s);
}

export function canTransition(from, to) {
  if (!isWalletStatus(from) || !isWalletStatus(to)) return false;
  if (from === to) return true; // idempotent re-entry (payload may change)
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`illegal wallet state transition: ${from} -> ${to}`);
  }
}
