// Fleet placement model for the setup screen.
//
// The editor works in *ship* terms (a 3-cell ship at C4, horizontal) because
// that is what a player drags around. The contract works in *board* terms (64
// cells, 7 occupied). `toBoard()` is the bridge, and `validatePlacement()`
// always finishes by running shared's `assertValidFleet` on that board, so the
// UI can never accept a fleet the contract would reject.
//
// Deliberate non-rule: ships are allowed to touch. The deployed circuit is
// Tier B (cell count + bounds, docs/01 section 5), so adjacency is not a
// protocol rule and the editor must not invent one - it would let a player
// build a legal fleet the UI refuses.
import {
  GRID_SIZE,
  GRID_CELLS,
  FLEET_SHAPES,
  FLEET_CELLS,
  ORIENTATION,
  coordinateToIndex,
  assertValidFleet,
} from './protocol.js';

/**
 * @typedef {{ id: string, size: number, x: number|null, y: number|null,
 *             orientation: 'horizontal'|'vertical' }} Ship
 * @typedef {{ ships: Ship[] }} Placement
 */

/** @returns {Placement} one unplaced ship per entry of FLEET_SHAPES */
export function createPlacement() {
  return {
    ships: FLEET_SHAPES.map((size, i) => ({
      id: `ship-${i + 1}`,
      size,
      x: null,
      y: null,
      orientation: ORIENTATION.HORIZONTAL,
    })),
  };
}

/** Cells a ship would occupy, as board indices. Empty for an unplaced ship. */
export function shipCells(ship) {
  if (ship.x === null || ship.y === null) return [];
  const horizontal = ship.orientation === ORIENTATION.HORIZONTAL;
  const cells = [];
  for (let i = 0; i < ship.size; i += 1) {
    const x = ship.x + (horizontal ? i : 0);
    const y = ship.y + (horizontal ? 0 : i);
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return []; // off-board: not placeable
    cells.push(coordinateToIndex({ x, y }));
  }
  return cells;
}

/** True when the ship fits fully on the board at its current anchor. */
export function fitsOnBoard(ship) {
  return shipCells(ship).length === ship.size;
}

function occupiedBy(placement, exceptId) {
  const used = new Set();
  for (const ship of placement.ships) {
    if (ship.id === exceptId) continue;
    for (const idx of shipCells(ship)) used.add(idx);
  }
  return used;
}

/**
 * Can `shipId` sit at this anchor/orientation?
 * @returns {{ ok: boolean, reason?: string, cells: number[] }}
 */
export function canPlace(placement, shipId, { x, y, orientation }) {
  const ship = placement.ships.find((s) => s.id === shipId);
  if (!ship) return { ok: false, reason: `no ship "${shipId}"`, cells: [] };
  const candidate = { ...ship, x, y, orientation: orientation ?? ship.orientation };
  const cells = shipCells(candidate);
  if (cells.length !== candidate.size) {
    return { ok: false, reason: 'ship runs off the board', cells: [] };
  }
  const used = occupiedBy(placement, shipId);
  const clash = cells.find((idx) => used.has(idx));
  if (clash !== undefined) return { ok: false, reason: 'ships would overlap', cells };
  return { ok: true, cells };
}

/**
 * Place a ship. Pure: returns a new placement, never mutates the input.
 * @throws {Error} when the move is illegal (bounds or overlap)
 */
export function placeShip(placement, shipId, { x, y, orientation }) {
  const check = canPlace(placement, shipId, { x, y, orientation });
  if (!check.ok) throw new Error(check.reason);
  return {
    ships: placement.ships.map((s) =>
      s.id === shipId ? { ...s, x, y, orientation: orientation ?? s.orientation } : s),
  };
}

/** Lift a ship back into the tray. */
export function removeShip(placement, shipId) {
  return {
    ships: placement.ships.map((s) => (s.id === shipId ? { ...s, x: null, y: null } : s)),
  };
}

/**
 * Rotate in place. An unplaced ship just flips. A placed ship keeps its anchor
 * if the rotation is legal there, and is rejected otherwise (no silent nudging -
 * the player should see why it will not turn).
 */
export function rotateShip(placement, shipId) {
  const ship = placement.ships.find((s) => s.id === shipId);
  if (!ship) throw new Error(`no ship "${shipId}"`);
  const flipped = ship.orientation === ORIENTATION.HORIZONTAL
    ? ORIENTATION.VERTICAL
    : ORIENTATION.HORIZONTAL;
  if (ship.x === null || ship.y === null) {
    return { ships: placement.ships.map((s) => (s.id === shipId ? { ...s, orientation: flipped } : s)) };
  }
  return placeShip(placement, shipId, { x: ship.x, y: ship.y, orientation: flipped });
}

/** @returns {Array<0|1>} 64-cell board, the exact shape `commitBoard` takes */
export function toBoard(placement) {
  const board = Array(GRID_CELLS).fill(0);
  for (const ship of placement.ships) {
    for (const idx of shipCells(ship)) board[idx] = 1;
  }
  return board;
}

/** Which ship (if any) covers a board index - used for hover/erase in the editor. */
export function shipAt(placement, index) {
  return placement.ships.find((s) => shipCells(s).includes(index)) ?? null;
}

/**
 * Full validation, ending in shared's `assertValidFleet`.
 * @returns {{ ok: boolean, errors: string[], board: Array<0|1>|null }}
 */
export function validatePlacement(placement) {
  const errors = [];
  const unplaced = placement.ships.filter((s) => s.x === null || s.y === null);
  if (unplaced.length > 0) {
    errors.push(`${unplaced.length} ship${unplaced.length > 1 ? 's' : ''} still to place`);
  }
  for (const ship of placement.ships) {
    if ((ship.x !== null || ship.y !== null) && !fitsOnBoard(ship)) {
      errors.push(`${ship.id} runs off the board`);
    }
  }
  const seen = new Set();
  for (const ship of placement.ships) {
    for (const idx of shipCells(ship)) {
      if (seen.has(idx)) { errors.push('ships overlap'); break; }
      seen.add(idx);
    }
  }
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)], board: null };

  const board = toBoard(placement);
  try {
    assertValidFleet(board); // the contract's own rule, not a copy of it
  } catch (err) {
    return { ok: false, errors: [err.message], board: null };
  }
  return { ok: true, errors: [], board };
}

/**
 * Random legal fleet, as ships (shared's `randomFleet` returns a bare board,
 * which the editor cannot pick apart into draggable pieces).
 * @param {() => number} rng
 */
export function autoPlace(rng = Math.random) {
  for (let restart = 0; restart < 50; restart += 1) {
    let placement = createPlacement();
    let ok = true;
    for (const ship of createPlacement().ships) {
      let placed = false;
      for (let attempt = 0; attempt < 400 && !placed; attempt += 1) {
        const orientation = rng() < 0.5 ? ORIENTATION.HORIZONTAL : ORIENTATION.VERTICAL;
        const horizontal = orientation === ORIENTATION.HORIZONTAL;
        const x = Math.floor(rng() * (horizontal ? GRID_SIZE - ship.size + 1 : GRID_SIZE));
        const y = Math.floor(rng() * (horizontal ? GRID_SIZE : GRID_SIZE - ship.size + 1));
        if (canPlace(placement, ship.id, { x, y, orientation }).ok) {
          placement = placeShip(placement, ship.id, { x, y, orientation });
          placed = true;
        }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok && validatePlacement(placement).ok) return placement;
  }
  // Degenerate rng (e.g. always 0): deterministic first-fit, still validated.
  let placement = createPlacement();
  for (const ship of placement.ships) {
    let placed = false;
    for (let y = 0; y < GRID_SIZE && !placed; y += 1) {
      for (let x = 0; x < GRID_SIZE && !placed; x += 1) {
        for (const orientation of [ORIENTATION.HORIZONTAL, ORIENTATION.VERTICAL]) {
          if (canPlace(placement, ship.id, { x, y, orientation }).ok) {
            placement = placeShip(placement, ship.id, { x, y, orientation });
            placed = true;
            break;
          }
        }
      }
    }
    if (!placed) throw new Error('could not auto-place fleet');
  }
  return placement;
}

export { FLEET_SHAPES, FLEET_CELLS };
