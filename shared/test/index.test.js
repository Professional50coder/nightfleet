// @nightfleet/shared tests: coordinate codec round-trips, fleet validity,
// randomFleet invariants (incl. degenerate-rng first-fit fallback).
import { describe, it, expect } from 'vitest';
import {
  GRID_SIZE, GRID_CELLS, FLEET_SHAPES, FLEET_CELLS,
  isCoordinate, coordinateToIndex, indexToCoordinate,
  formatCoordinate, parseCoordinate, assertValidFleet, randomFleet,
} from '../index.js';

// Deterministic LCG so "random" fleets are reproducible in tests.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('coordinate codec', () => {
  it('index round-trips all 64 cells (idx = y * 8 + x)', () => {
    for (let i = 0; i < GRID_CELLS; i += 1) {
      const c = indexToCoordinate(i);
      expect(isCoordinate(c)).toBe(true);
      expect(coordinateToIndex(c)).toBe(i);
      expect(c).toEqual({ x: i % GRID_SIZE, y: Math.floor(i / GRID_SIZE) });
    }
  });

  it('A1..H8 notation round-trips all 64 cells', () => {
    for (let i = 0; i < GRID_CELLS; i += 1) {
      const c = indexToCoordinate(i);
      expect(parseCoordinate(formatCoordinate(c))).toEqual(c);
    }
    expect(formatCoordinate({ x: 0, y: 0 })).toBe('A1');
    expect(formatCoordinate({ x: 7, y: 7 })).toBe('H8');
  });

  it('parser tolerates lowercase and whitespace, rejects junk', () => {
    expect(parseCoordinate('  c3 ')).toEqual({ x: 2, y: 2 });
    expect(() => parseCoordinate('A0')).toThrow(RangeError);
    expect(() => parseCoordinate('I1')).toThrow(RangeError);
    expect(() => parseCoordinate('A9')).toThrow(RangeError);
    expect(() => parseCoordinate('AA')).toThrow(RangeError);
    expect(() => parseCoordinate('')).toThrow(RangeError);
  });

  it('rejects out-of-range conversions', () => {
    expect(() => coordinateToIndex({ x: -1, y: 0 })).toThrow(RangeError);
    expect(() => coordinateToIndex({ x: 0, y: 8 })).toThrow(RangeError);
    expect(() => coordinateToIndex({ x: 0.5, y: 0 })).toThrow(RangeError);
    expect(() => indexToCoordinate(-1)).toThrow(RangeError);
    expect(() => indexToCoordinate(64)).toThrow(RangeError);
    expect(() => indexToCoordinate(1.5)).toThrow(RangeError);
    expect(() => formatCoordinate({ x: 8, y: 0 })).toThrow(RangeError);
  });
});

describe('fleet validity (Tier B)', () => {
  const good = (() => { const b = Array(GRID_CELLS).fill(0); for (const i of [0, 1, 2, 8, 9, 16, 17]) b[i] = 1; return b; })();

  it('accepts exactly 7 occupied cells', () => {
    expect(() => assertValidFleet(good)).not.toThrow();
  });

  it('rejects wrong length, non-binary cells, and wrong cell counts', () => {
    expect(() => assertValidFleet(good.slice(0, 63))).toThrow(/64 cells/);
    const two = [...good]; two[63] = 2;
    expect(() => assertValidFleet(two)).toThrow(/0 or 1/);
    const six = [...good]; six[0] = 0;
    expect(() => assertValidFleet(six)).toThrow(/exactly 7 cells/);
    const eight = [...good]; eight[63] = 1;
    expect(() => assertValidFleet(eight)).toThrow(/exactly 7 cells/);
  });
});

describe('randomFleet', () => {
  it('produces valid fleets matching FLEET_SHAPES across many seeds', () => {
    expect(FLEET_SHAPES.reduce((t, s) => t + s, 0)).toBe(FLEET_CELLS);
    for (let seed = 1; seed <= 50; seed += 1) {
      const board = randomFleet(lcg(seed));
      expect(board).toHaveLength(GRID_CELLS);
      expect(board.reduce((t, c) => t + c, 0)).toBe(FLEET_CELLS);
      expect(() => assertValidFleet(board)).not.toThrow();
    }
  });

  it('is deterministic for the same rng sequence', () => {
    expect(randomFleet(lcg(42))).toEqual(randomFleet(lcg(42)));
  });

  it('first-fit fallback still yields a valid fleet under a degenerate rng', () => {
    const zero = () => 0; // every random attempt lands on the same spot
    const board = randomFleet(zero);
    expect(board.reduce((t, c) => t + c, 0)).toBe(FLEET_CELLS);
    expect(() => assertValidFleet(board)).not.toThrow();
  });
});
