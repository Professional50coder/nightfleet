// The game-driver seam.
//
// WHY THIS EXISTS
// ---------------
// `api/LocalGame` drives the real Compact circuits through
// `@midnight-ntwrk/compact-runtime`. That package is Node-side (it reaches for
// node:crypto and the compiled ZK assets in contract/managed/) and does not
// belong in a browser bundle. Rather than shim it in, the UI talks only to this
// interface, and the thing behind it is swappable:
//
//   BrowserLocalDriver  - pure JS, `shared/` rules, runs in the browser today.
//                         Honest about what it is: no proofs, no chain. It is a
//                         faithful model of the contract's *state machine*, so
//                         the UI it drives is the UI a proof-backed driver drives.
//   MidnightDriver      - the seat a proof-server / Preprod driver takes. It is a
//                         declared stub: every method rejects with a clear
//                         message until the transport lands (M1). It exists so
//                         the shape is fixed and testable now.
//
// THE CONTRACT OF THIS INTERFACE
// ------------------------------
// 1. Every method is async. The browser driver resolves immediately; a proving
//    driver takes seconds. The UI awaits either without changing.
// 2. `getState()` returns PUBLIC state only - see the fog rule below.
// 3. Methods reject with `DriverError`; the UI shows `err.message` verbatim, so
//    a driver's message is player-facing copy.
//
// THE FOG RULE (a privacy property, enforced here, tested in test/fog-of-war.test.js)
// ----------------------------------------------------------------------------------
// `getState().opponent` describes ONLY cells you have fired at. A cell you have
// not fired at is MARK.UNKNOWN, and no other field may let you deduce it -
// no ship counts per row, no "ships remaining" shape list, no full board. The
// opponent's layout leaves the driver in exactly one place: `revealFleets()`,
// which is gated on the game being FINISHED. This mirrors what the contract
// guarantees on-chain (report() discloses one cell; revealBoard() is the
// post-game audit), so a UI that respects it here respects it there.

import { PHASE, MARK, SEAT } from './protocol.js';

/** Any driver-level failure. `message` is shown to the player as-is. */
export class DriverError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriverError';
  }
}

/**
 * The methods every driver must implement. Used by `assertDriverShape` and by
 * the conformance test that runs over both implementations.
 */
export const DRIVER_METHODS = Object.freeze([
  'describe',
  'newGame',
  'commitFleet',
  'fire',
  'getState',
  'getShotLog',
  'getNarration',
  'revealFleets',
  'subscribe',
]);

/**
 * @typedef {object} DriverInfo
 * @property {string} id            stable key, e.g. 'browser-local'
 * @property {string} name          player-facing label
 * @property {boolean} provesMoves  true once real ZK proofs back each report
 * @property {boolean} onChain      true once state lives on a Midnight ledger
 * @property {string} summary       one line for the HUD "what am I playing?" chip
 *
 * @typedef {object} SeatView
 * @property {Array<0|1>|null} fleet  your own layout; ALWAYS null for the opponent seat
 * @property {number[]} marks         64 entries of MARK - what has been fired at this seat
 * @property {number} hitsTaken       how many of this seat's 7 cells are proven hit
 *
 * @typedef {object} PublicState
 * @property {string} phase           one of PHASE
 * @property {'you'|'opponent'|null} turn
 * @property {'you'|'opponent'|null} winner
 * @property {number} fleetCells      7, from shared
 * @property {SeatView} you
 * @property {SeatView} opponent
 * @property {{seat: string, coord: {x:number,y:number}, result: 'hit'|'miss'}|null} lastShot
 * @property {boolean} revealed       true once revealFleets() has run
 *
 * @typedef {object} ShotLogEntry
 * @property {number} seq
 * @property {string} circuit         'commitBoard' | 'fire' | 'report' | 'claimWin' | 'revealBoard'
 * @property {'you'|'opponent'} seat
 * @property {{x:number,y:number}} [coord]
 * @property {'hit'|'miss'} [result]
 */

/**
 * A driver that is not wired up yet. Every call rejects with `reason`, which the
 * UI renders directly. `describe()` and `subscribe()` still work so the driver
 * can be listed and selected without blowing up the app.
 */
export class UnavailableDriver {
  /** @param {DriverInfo} info @param {string} reason */
  constructor(info, reason) {
    this.info = info;
    this.reason = reason;
    this.listeners = new Set();
  }

  async describe() { return { ...this.info, available: false, reason: this.reason }; }
  async newGame() { throw new DriverError(this.reason); }
  async commitFleet() { throw new DriverError(this.reason); }
  async fire() { throw new DriverError(this.reason); }
  async getState() { throw new DriverError(this.reason); }
  async getShotLog() { throw new DriverError(this.reason); }
  async getNarration() { throw new DriverError(this.reason); }
  async revealFleets() { throw new DriverError(this.reason); }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Throws unless `driver` implements every method in DRIVER_METHODS. */
export function assertDriverShape(driver, label = 'driver') {
  if (!driver || typeof driver !== 'object') throw new TypeError(`${label} is not a driver`);
  const missing = DRIVER_METHODS.filter((m) => typeof driver[m] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`${label} is missing driver method(s): ${missing.join(', ')}`);
  }
  return driver;
}

/** A fresh, fully-fogged seat view. The only way to build `opponent`. */
export function emptySeatView({ fleet = null } = {}) {
  return { fleet, marks: Array(64).fill(MARK.UNKNOWN), hitsTaken: 0 };
}

export { PHASE, MARK, SEAT };
