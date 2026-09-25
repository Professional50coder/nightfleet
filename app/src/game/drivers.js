// Driver registry - the one place that knows which implementations exist.
//
// Adding the proof-backed driver later means replacing `createMidnightDriver`
// with the real class here. Nothing else in the app changes: the UI resolves a
// driver through this registry and then only ever calls the interface.
import { BrowserLocalDriver } from './local-driver.js';
import { createMidnightDriver, MIDNIGHT_DRIVER_INFO } from './midnight-driver.js';

export { DIFFICULTIES } from '../../../ai/opponent.js';

export const DRIVER_IDS = Object.freeze({
  LOCAL: 'browser-local',
  MIDNIGHT: MIDNIGHT_DRIVER_INFO.id,
});

/** @returns {object} a driver for `id`, defaulting to the in-browser one. */
export function createDriverById(id, opts = {}) {
  if (id === DRIVER_IDS.MIDNIGHT) return createMidnightDriver();
  return new BrowserLocalDriver(opts);
}

/**
 * Static catalogue for the picker, without instantiating anything.
 * `available: false` entries carry the reason so the UI can say it out loud.
 */
export function listDrivers() {
  return [
    {
      id: DRIVER_IDS.LOCAL,
      name: 'Local (in-browser)',
      available: true,
      provesMoves: false,
      summary: 'Rules run in your browser from the same shared/ module the contract uses.',
    },
    {
      ...MIDNIGHT_DRIVER_INFO,
      available: true,
      summary: MIDNIGHT_DRIVER_INFO.summary
        + ' Two players, one squad link: the host deploys a fresh contract from the browser, the opponent joins from the link.',
    },
  ];
}
