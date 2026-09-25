// MidnightDriver - the seat the proof-backed driver will take.
//
// STATUS: declared, not implemented. Every call rejects with the reason below.
// It is here so the seam is a real, testable two-implementation interface
// rather than a promise in a comment, and so the driver picker in the UI can
// show the path that is coming and why it is not live yet.
//
// WHAT IT WILL DO
// ---------------
// `api/LocalGame` already drives the five circuits (joinGame, commitBoard,
// fire, report, claimWin, revealBoard) through @midnight-ntwrk/compact-runtime.
// That runtime is Node-side: it loads the compiled ZK assets from
// contract/managed/ and uses node:crypto. It will not run inside a browser
// bundle, and forcing it in (polyfills, shims) buys a broken build, not a game.
//
// So the real implementation is a *transport*, not a port:
//
//   browser  ──HTTP/WS──►  node host (or Lace + proof server)
//   UI           this file        api/LocalGame  ─►  contract/managed  ─►  proof server
//
// Each method below maps 1:1 onto a LocalGame call:
//
//   newGame()      -> LocalGame.create() + addPlayer() x2      (or join a deployed address)
//   commitFleet()  -> game.commitBoard(handle, board, salt)    board NEVER leaves the browser
//                                                              in the wallet build; it is the
//                                                              witness fed to the local prover
//   fire()         -> game.fire(handle, coord) then await the defender's report()
//   getState()     -> game.state(), projected through the same fog rule as here
//   getShotLog()   -> game.shotLog()
//   revealFleets() -> game.revealBoard(handle)
//
// THE ONE RULE A REAL IMPLEMENTATION MUST NOT BREAK
// -------------------------------------------------
// `getState()` must project the ledger the way BrowserLocalDriver does: the
// opponent seat carries marks for fired cells and nothing else. The contract
// guarantees this on-chain (report() discloses a single cell), so the driver's
// job is not to re-derive the guarantee but to avoid *widening* it - e.g. by
// passing through a debug field, or by caching a revealed board and serving it
// before the game is FINISHED. test/fog-of-war.test.js runs its fog assertions
// against the driver interface, not against one class, so a future
// implementation inherits that test by construction.

import { UnavailableDriver } from './driver.js';

export const MIDNIGHT_DRIVER_REASON =
  'The proof-backed driver is not wired up yet. @midnight-ntwrk/compact-runtime ' +
  'runs the real circuits in Node, not in the browser, so this seat waits on the ' +
  'proof-server transport (M1). Play the in-browser local game in the meantime.';

export const MIDNIGHT_DRIVER_INFO = Object.freeze({
  id: 'midnight-preprod',
  name: 'Midnight Preprod (proof-backed)',
  provesMoves: true,
  onChain: true,
  summary:
    'Every report answered by a zero-knowledge proof against your committed board, ' +
    'settled on Midnight Preprod.',
});

/**
 * @returns {UnavailableDriver} a shape-complete driver whose every method
 * rejects with MIDNIGHT_DRIVER_REASON.
 */
export function createMidnightDriver() {
  return new UnavailableDriver(MIDNIGHT_DRIVER_INFO, MIDNIGHT_DRIVER_REASON);
}
