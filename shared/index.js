// @nightfleet/shared - protocol constants, coordinates, fleet helpers.
// Runtime JS used by api/, cli/ and ai/. This module is the single source of
// truth for the rules; the values below must match
// contract/src/nightfleet.compact exactly.

// Protocol constants (must match nightfleet/contract/src/nightfleet.compact)
export const GRID_SIZE = 8;
export const GRID_CELLS = GRID_SIZE * GRID_SIZE; // 64
export const FLEET_SHAPES = Object.freeze([3, 2, 2]);
export const FLEET_CELLS = FLEET_SHAPES.reduce((t, s) => t + s, 0); // 7

// Toolchain pins (https://docs.midnight.network/relnotes/support-matrix)
export const TOOLCHAIN = Object.freeze({
  compactDevtools: '0.5.1',
  compactCompiler: '0.31.1',
  compactRuntime: '0.16.0',
  onchainRuntimeV3: '^3.0.0',
});

// Local dev stack endpoints. Node/indexer ports are set by
// midnight-local-dev and land here when M0 wires the real stack.
export const NETWORKS = Object.freeze({
  local: { proofServer: 'http://localhost:6300' },
});

/** @typedef {{ x: number, y: number }} Coordinate */

export function isCoordinate(c) {
  return Number.isInteger(c.x) && Number.isInteger(c.y) &&
    c.x >= 0 && c.x < GRID_SIZE && c.y >= 0 && c.y < GRID_SIZE;
}

// Contract mapping: idx = y * 8 + x (see report() in nightfleet.compact)
export function coordinateToIndex(c) {
  if (!isCoordinate(c)) throw new RangeError(`Coordinate (${c.x}, ${c.y}) is outside the 8x8 board`);
  return c.y * GRID_SIZE + c.x;
}

export function indexToCoordinate(index) {
  if (!Number.isInteger(index) || index < 0 || index >= GRID_CELLS) {
    throw new RangeError(`Cell index ${index} is outside the 8x8 board`);
  }
  return { x: index % GRID_SIZE, y: Math.floor(index / GRID_SIZE) };
}

// Battleship notation: A1..H8 (letter = column x, number = row y + 1)
export function formatCoordinate(c) {
  if (!isCoordinate(c)) throw new RangeError(`Coordinate (${c.x}, ${c.y}) is outside the 8x8 board`);
  return `${String.fromCharCode(65 + c.x)}${c.y + 1}`;
}

export function parseCoordinate(text) {
  const m = /^\s*([A-Ha-h])\s*([1-8])\s*$/.exec(text);
  if (!m) throw new RangeError(`"${text}" is not a coordinate; use A1..H8`);
  return { x: m[1].toUpperCase().charCodeAt(0) - 65, y: Number(m[2]) - 1 };
}

export function assertValidFleet(board) {
  if (!Array.isArray(board) || board.length !== GRID_CELLS) {
    throw new Error(`Board must contain exactly ${GRID_CELLS} cells; received ${board?.length}`);
  }
  const bad = board.findIndex((cell) => cell !== 0 && cell !== 1);
  if (bad !== -1) throw new Error(`Board cell ${bad} must be 0 or 1`);
  const occupied = board.reduce((t, c) => t + c, 0);
  if (occupied !== FLEET_CELLS) {
    throw new Error(`Fleet must occupy exactly ${FLEET_CELLS} cells; received ${occupied}`);
  }
}

/** Random valid fleet: ships of FLEET_SHAPES, non-overlapping, in bounds. */
export function randomFleet(rng = Math.random) {
  const board = Array(GRID_CELLS).fill(0);
  for (const size of FLEET_SHAPES) {
    let placed = false;
    for (let attempt = 0; attempt < 1000 && !placed; attempt += 1) {
      const horizontal = rng() < 0.5;
      const x = Math.floor(rng() * (horizontal ? GRID_SIZE - size + 1 : GRID_SIZE));
      const y = Math.floor(rng() * (horizontal ? GRID_SIZE : GRID_SIZE - size + 1));
      const cells = Array.from({ length: size }, (_, i) =>
        coordinateToIndex({ x: x + (horizontal ? i : 0), y: y + (horizontal ? 0 : i) }));
      if (cells.some((i) => board[i] === 1)) continue;
      for (const i of cells) board[i] = 1;
      placed = true;
    }
    // Degenerate-rng fallback: deterministic first-fit scan
    if (!placed) {
      outer: for (const horizontal of [true, false]) {
        const maxX = horizontal ? GRID_SIZE - size : GRID_SIZE - 1;
        const maxY = horizontal ? GRID_SIZE - 1 : GRID_SIZE - size;
        for (let y = 0; y <= maxY; y += 1) {
          for (let x = 0; x <= maxX; x += 1) {
            const cells = Array.from({ length: size }, (_, i) =>
              coordinateToIndex({ x: x + (horizontal ? i : 0), y: y + (horizontal ? 0 : i) }));
            if (cells.some((i) => board[i] === 1)) continue;
            for (const i of cells) board[i] = 1;
            placed = true;
            break outer;
          }
        }
      }
    }
    if (!placed) throw new Error('could not place fleet (board full?)');
  }
  return board;
}
