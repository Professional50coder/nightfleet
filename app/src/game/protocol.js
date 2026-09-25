// Protocol surface for the browser.
//
// Every rule the UI enforces comes from `@nightfleet/shared` (../../shared/index.js)
// so the browser, the CLI and the Compact contract agree on one set of constants.
// Nothing is redefined here: this module only re-exports shared and adds
// presentation-level vocabulary (cell marks, seat names) that the contract has
// no opinion about.
export {
  GRID_SIZE,
  GRID_CELLS,
  FLEET_SHAPES,
  FLEET_CELLS,
  isCoordinate,
  coordinateToIndex,
  indexToCoordinate,
  formatCoordinate,
  parseCoordinate,
  assertValidFleet,
  randomFleet,
} from '../../../shared/index.js';

/**
 * Phases, named exactly as `Phase` in contract/src/nightfleet.compact.
 * The seat that joins first is p1 and fires first; in this app that is you.
 */
export const PHASE = Object.freeze({
  OPEN: 'OPEN',
  PLACED_1: 'PLACED_1',
  PLACED_2: 'PLACED_2',
  PLAYING: 'PLAYING',
  FINISHED: 'FINISHED',
});

/** What a single cell of a rendered board knows. */
export const MARK = Object.freeze({
  UNKNOWN: 0, // never fired at - the fog
  MISS: 1,    // fired at, proven empty
  HIT: 2,     // fired at, proven occupied
});

/** Seats, used as stable keys in public state and the shot log. */
export const SEAT = Object.freeze({ YOU: 'you', OPPONENT: 'opponent' });

/** Ship orientations for the placement editor. */
export const ORIENTATION = Object.freeze({ HORIZONTAL: 'horizontal', VERTICAL: 'vertical' });
