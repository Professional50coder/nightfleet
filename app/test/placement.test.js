// Placement validation. The point of these tests is that the editor cannot
// accept a fleet the contract would reject, and cannot reject one it would
// accept - both directions matter.
import { describe, expect, it } from 'vitest';
import {
  autoPlace, canPlace, createPlacement, placeShip, removeShip,
  rotateShip, shipAt, shipCells, toBoard, validatePlacement,
} from '../src/game/placement.js';
import { FLEET_CELLS, FLEET_SHAPES, GRID_SIZE, ORIENTATION, assertValidFleet, coordinateToIndex } from '../src/game/protocol.js';
import { mulberry32 } from '../../ai/opponent.js';

const H = ORIENTATION.HORIZONTAL;
const V = ORIENTATION.VERTICAL;

/** A known-good fleet: 3 at A1 across, 2 at A3 across, 2 at A5 down. */
function goodPlacement() {
  let p = createPlacement();
  p = placeShip(p, 'ship-1', { x: 0, y: 0, orientation: H });
  p = placeShip(p, 'ship-2', { x: 0, y: 2, orientation: H });
  p = placeShip(p, 'ship-3', { x: 0, y: 4, orientation: V });
  return p;
}

describe('createPlacement', () => {
  it('makes one unplaced ship per FLEET_SHAPES entry', () => {
    const p = createPlacement();
    expect(p.ships.map((s) => s.size)).toEqual([...FLEET_SHAPES]);
    expect(p.ships.every((s) => s.x === null && s.y === null)).toBe(true);
  });
});

describe('shipCells', () => {
  it('walks right for horizontal and down for vertical', () => {
    expect(shipCells({ id: 'a', size: 3, x: 2, y: 1, orientation: H }))
      .toEqual([2, 3, 4].map((x) => coordinateToIndex({ x, y: 1 })));
    expect(shipCells({ id: 'a', size: 3, x: 2, y: 1, orientation: V }))
      .toEqual([1, 2, 3].map((y) => coordinateToIndex({ x: 2, y })));
  });

  it('returns nothing for an unplaced or off-board ship', () => {
    expect(shipCells({ id: 'a', size: 3, x: null, y: null, orientation: H })).toEqual([]);
    expect(shipCells({ id: 'a', size: 3, x: GRID_SIZE - 1, y: 0, orientation: H })).toEqual([]);
  });
});

describe('canPlace', () => {
  it('rejects a ship that runs off the right edge', () => {
    const p = createPlacement();
    const r = canPlace(p, 'ship-1', { x: 6, y: 0, orientation: H });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/off the board/);
  });

  it('rejects a ship that runs off the bottom edge', () => {
    const p = createPlacement();
    expect(canPlace(p, 'ship-1', { x: 0, y: 6, orientation: V }).ok).toBe(false);
  });

  it('rejects an overlap', () => {
    let p = createPlacement();
    p = placeShip(p, 'ship-1', { x: 0, y: 0, orientation: H }); // A1..C1
    const r = canPlace(p, 'ship-2', { x: 2, y: 0, orientation: H }); // C1..D1
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/overlap/);
  });

  it('allows ships to touch — adjacency is not a protocol rule (Tier B)', () => {
    let p = createPlacement();
    p = placeShip(p, 'ship-1', { x: 0, y: 0, orientation: H }); // A1..C1
    expect(canPlace(p, 'ship-2', { x: 3, y: 0, orientation: H }).ok).toBe(true); // D1..E1
    expect(canPlace(p, 'ship-2', { x: 0, y: 1, orientation: H }).ok).toBe(true); // directly below
  });

  it('ignores the moving ship’s own cells when re-anchoring it', () => {
    const p = goodPlacement();
    expect(canPlace(p, 'ship-1', { x: 1, y: 0, orientation: H }).ok).toBe(true);
  });
});

describe('placeShip / removeShip / rotateShip', () => {
  it('is pure — the input placement is untouched', () => {
    const p = createPlacement();
    const q = placeShip(p, 'ship-1', { x: 0, y: 0, orientation: H });
    expect(p.ships[0].x).toBeNull();
    expect(q.ships[0].x).toBe(0);
  });

  it('throws on an illegal placement rather than silently clamping', () => {
    const p = createPlacement();
    expect(() => placeShip(p, 'ship-1', { x: 7, y: 0, orientation: H })).toThrow(/off the board/);
  });

  it('removeShip puts a ship back in the dock', () => {
    const p = removeShip(goodPlacement(), 'ship-1');
    expect(p.ships.find((s) => s.id === 'ship-1').x).toBeNull();
    expect(validatePlacement(p).ok).toBe(false);
  });

  it('rotates an unplaced ship freely', () => {
    const p = rotateShip(createPlacement(), 'ship-1');
    expect(p.ships[0].orientation).toBe(V);
  });

  it('refuses to rotate a placed ship into an illegal spot', () => {
    let p = createPlacement();
    p = placeShip(p, 'ship-1', { x: 0, y: 6, orientation: H }); // A7..C7; vertical would overrun
    expect(() => rotateShip(p, 'ship-1')).toThrow(/off the board/);
  });
});

describe('shipAt', () => {
  it('finds the ship covering a cell, and nothing for open water', () => {
    const p = goodPlacement();
    expect(shipAt(p, coordinateToIndex({ x: 1, y: 0 })).id).toBe('ship-1');
    expect(shipAt(p, coordinateToIndex({ x: 7, y: 7 }))).toBeNull();
  });
});

describe('validatePlacement', () => {
  it('accepts a complete legal fleet and returns a contract-shaped board', () => {
    const r = validatePlacement(goodPlacement());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.board).toHaveLength(64);
    expect(r.board.reduce((t, c) => t + c, 0)).toBe(FLEET_CELLS);
    expect(() => assertValidFleet(r.board)).not.toThrow();
  });

  it('reports ships still in the dock and hands back no board', () => {
    const r = validatePlacement(createPlacement());
    expect(r.ok).toBe(false);
    expect(r.board).toBeNull();
    expect(r.errors.join(' ')).toMatch(/still to place/);
  });

  it('is the same rule shared/ enforces — a 6-cell fleet fails both', () => {
    let p = createPlacement();
    p = placeShip(p, 'ship-1', { x: 0, y: 0, orientation: H });
    p = placeShip(p, 'ship-2', { x: 0, y: 2, orientation: H });
    const r = validatePlacement(p);
    expect(r.ok).toBe(false);
    expect(() => assertValidFleet(toBoard(p))).toThrow(/exactly 7 cells/);
  });
});

describe('autoPlace', () => {
  it('produces a fleet that passes shared’s assertValidFleet, seeded', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const p = autoPlace(mulberry32(seed));
      const r = validatePlacement(p);
      expect(r.ok, `seed ${seed}: ${r.errors.join(', ')}`).toBe(true);
      expect(() => assertValidFleet(r.board)).not.toThrow();
    }
  });

  it('survives a degenerate rng that always returns 0', () => {
    const r = validatePlacement(autoPlace(() => 0));
    expect(r.ok).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    expect(toBoard(autoPlace(mulberry32(7)))).toEqual(toBoard(autoPlace(mulberry32(7))));
  });
});
