// @nightfleet/ai - deterministic AI opponent (docs/06-INTELLIGENT-LAYER.md §2).
// Pure engine: seeded, no LLM, no I/O. The opponent plays the real contract
// through api/ (see game-player.js); this module only decides shots.
//
// Difficulty tiers (per docs):
//   easy   - random unshot cell
//   medium - hunt on a parity grid; on a hit, target orthogonal neighbors and
//            follow hit lines until the ship is finished
//   hard   - probability-density map of the remaining fleet shapes
//
// The contract reports only hit/miss (no sink notifications), so a hit cell
// stays "unresolved" for targeting until its line cannot extend further.

import { GRID_SIZE, GRID_CELLS, FLEET_SHAPES, coordinateToIndex, indexToCoordinate, randomFleet } from '../shared/index.js';

export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);

/** mulberry32: tiny seeded PRNG, deterministic across runs and platforms. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNKNOWN = -1, MISS = 0, HIT = 1;

export class Opponent {
  /** @param {{ difficulty?: 'easy'|'medium'|'hard', seed?: number }} opts */
  constructor({ difficulty = 'medium', seed = 1 } = {}) {
    if (!DIFFICULTIES.includes(difficulty)) {
      throw new RangeError(`difficulty must be one of ${DIFFICULTIES.join('/')}; got "${difficulty}"`);
    }
    this.difficulty = difficulty;
    this.rng = mulberry32(seed);
    this.known = Array(GRID_CELLS).fill(UNKNOWN);
    this.shots = []; // [{ x, y, result }] in fire order
  }

  /** @returns {{ x: number, y: number }} the next cell to fire on */
  nextShot() {
    if (this.shots.length >= GRID_CELLS) throw new Error('board exhausted');
    switch (this.difficulty) {
      case 'easy': return this.#pick(this.#unknownCells());
      case 'hard': return this.#densityShot();
      default: return this.#mediumShot();
    }
  }

  /** Record the contract's answer for a shot previously chosen with nextShot(). */
  recordShot(coord, result) {
    if (result !== 'hit' && result !== 'miss') throw new RangeError(`result must be hit|miss; got "${result}"`);
    const idx = coordinateToIndex(coord);
    if (this.known[idx] !== UNKNOWN) throw new Error(`cell ${coord.x},${coord.y} already shot`);
    this.known[idx] = result === 'hit' ? HIT : MISS;
    this.shots.push({ x: coord.x, y: coord.y, result });
  }

  #unknownCells() {
    const out = [];
    for (let i = 0; i < GRID_CELLS; i += 1) if (this.known[i] === UNKNOWN) out.push(indexToCoordinate(i));
    return out;
  }

  #pick(cells) {
    if (cells.length === 0) throw new Error('no legal shot remains');
    return cells[Math.floor(this.rng() * cells.length)];
  }

  #mediumShot() {
    const lineEnds = this.#hitLineEnds();
    if (lineEnds.length > 0) return this.#pick(lineEnds);
    const neighbors = this.#hitNeighbors();
    if (neighbors.length > 0) return this.#pick(neighbors);
    const parity = this.#unknownCells().filter((c) => (c.x + c.y) % 2 === 0);
    return this.#pick(parity.length > 0 ? parity : this.#unknownCells());
  }

  // Cells extending a line of >=2 collinear adjacent hits (both directions).
  #hitLineEnds() {
    const ends = new Set();
    const at = (x, y) => (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE ? this.known[coordinateToIndex({ x, y })] : null);
    for (let y = 0; y < GRID_SIZE; y += 1) {
      for (let x = 0; x < GRID_SIZE; x += 1) {
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          let len = 0;
          while (at(x + dx * len, y + dy * len) === HIT) len += 1;
          if (len >= 2) {
            const before = { x: x - dx, y: y - dy };
            const after = { x: x + dx * len, y: y + dy * len };
            for (const c of [before, after]) {
              if (at(c.x, c.y) === UNKNOWN) ends.add(coordinateToIndex(c));
            }
          }
        }
      }
    }
    return [...ends].map(indexToCoordinate);
  }

  // Unknown orthogonal neighbors of isolated hits.
  #hitNeighbors() {
    const out = new Set();
    for (let i = 0; i < GRID_CELLS; i += 1) {
      if (this.known[i] !== HIT) continue;
      const { x, y } = indexToCoordinate(i);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = { x: x + dx, y: y + dy };
        if (c.x < 0 || c.x >= GRID_SIZE || c.y < 0 || c.y >= GRID_SIZE) continue;
        const j = coordinateToIndex(c);
        if (this.known[j] === UNKNOWN) out.add(j);
      }
    }
    return [...out].map(indexToCoordinate);
  }

  // hard: score each unknown cell by the number of remaining-fleet placements
  // that cover it and are consistent with observed misses; when hits are
  // unresolved, only placements covering at least one hit count.
  #densityShot() {
    const scores = new Map();
    const hits = [];
    for (let i = 0; i < GRID_CELLS; i += 1) if (this.known[i] === HIT) hits.push(i);
    for (const size of FLEET_SHAPES) {
      for (const horizontal of [true, false]) {
        const maxX = horizontal ? GRID_SIZE - size : GRID_SIZE - 1;
        const maxY = horizontal ? GRID_SIZE - 1 : GRID_SIZE - size;
        for (let y = 0; y <= maxY; y += 1) {
          for (let x = 0; x <= maxX; x += 1) {
            const cells = Array.from({ length: size }, (_, i) =>
              coordinateToIndex({ x: x + (horizontal ? i : 0), y: y + (horizontal ? 0 : i) }));
            if (cells.some((i) => this.known[i] === MISS)) continue;
            if (hits.length > 0 && !cells.some((i) => this.known[i] === HIT)) continue;
            for (const i of cells) {
              if (this.known[i] === UNKNOWN) scores.set(i, (scores.get(i) ?? 0) + 1);
            }
          }
        }
      }
    }
    let best = -1; let bestCells = [];
    for (const [i, s] of scores) {
      if (s > best) { best = s; bestCells = [i]; }
      else if (s === best) bestCells.push(i);
    }
    if (bestCells.length === 0) return this.#mediumShot(); // fallback: everything scored 0
    return indexToCoordinate(bestCells[Math.floor(this.rng() * bestCells.length)]);
  }
}

/**
 * Convenience fleet for the AI's own commitment: seeded so tests reproduce.
 * Returns a valid board (Array<64> of 0|1) for api.commitBoard().
 */
export function opponentFleet(seed) {
  return randomFleet(mulberry32(seed));
}
