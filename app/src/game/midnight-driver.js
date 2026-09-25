// MidnightDriver - the proof-backed driver, live.
//
// The seat this file held as a stub is now filled by ChainDriver
// (src/chain/chain-driver.js): Lace connects through the DApp Connector,
// one fresh contract deployment per squad, every move a proven circuit call
// on Midnight Preprod. The driver interface and the fog rule are unchanged -
// the UI cannot tell which implementation sits behind it, by design.

import { ChainDriver } from '../chain/chain-driver.js';

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
 * @returns {ChainDriver} the proof-backed driver (connects Lace on first use)
 */
export function createMidnightDriver(opts = {}) {
  return new ChainDriver(opts);
}
