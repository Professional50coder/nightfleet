// The driver seam.
//
// These tests hold the *interface*, not one implementation: the conformance
// block runs over every registered driver, so a future proof-backed driver has
// to satisfy the same shape before it can be listed.
import { describe, expect, it } from 'vitest';
import {
  DRIVER_METHODS, DriverError, assertDriverShape, emptySeatView,
} from '../src/game/driver.js';
import { BrowserLocalDriver, displayCommitment } from '../src/game/local-driver.js';
import { createMidnightDriver } from '../src/game/midnight-driver.js';
import { DRIVER_IDS, createDriverById, listDrivers } from '../src/game/drivers.js';
import { FLEET_CELLS, MARK, PHASE, SEAT, indexToCoordinate, randomFleet } from '../src/game/protocol.js';
import { mulberry32 } from '../../ai/opponent.js';

const fleet = () => randomFleet(mulberry32(42));

async function playToFinish(driver, { maxRounds = 200 } = {}) {
  await driver.newGame({ seed: 3, difficulty: 'medium' });
  await driver.commitFleet(fleet());
  for (let round = 0; round < maxRounds; round += 1) {
    const state = await driver.getState();
    if (state.phase === PHASE.FINISHED) return state;
    const next = state.opponent.marks.findIndex((m) => m === MARK.UNKNOWN);
    if (next === -1) break;
    await driver.fire(indexToCoordinate(next));
  }
  return driver.getState();
}

describe('driver shape', () => {
  it.each([
    ['BrowserLocalDriver', () => new BrowserLocalDriver()],
    ['MidnightDriver (stub)', () => createMidnightDriver()],
    ['registry: local', () => createDriverById(DRIVER_IDS.LOCAL)],
    ['registry: midnight', () => createDriverById(DRIVER_IDS.MIDNIGHT)],
  ])('%s implements every driver method', (_label, make) => {
    expect(() => assertDriverShape(make())).not.toThrow();
  });

  it('names the missing methods when something is not a driver', () => {
    expect(() => assertDriverShape({ fire() {} }, 'partial'))
      .toThrow(/partial is missing driver method\(s\):/);
    expect(() => assertDriverShape(null)).toThrow(/not a driver/);
  });

  it('exposes a stable method list', () => {
    expect(DRIVER_METHODS).toContain('fire');
    expect(DRIVER_METHODS).toContain('revealFleets');
    expect(Object.isFrozen(DRIVER_METHODS)).toBe(true);
  });

  it('emptySeatView starts fully fogged', () => {
    const view = emptySeatView();
    expect(view.fleet).toBeNull();
    expect(view.marks).toHaveLength(64);
    expect(view.marks.every((m) => m === MARK.UNKNOWN)).toBe(true);
  });
});

describe('MidnightDriver (live, chain-backed)', () => {
  it('describes itself as available and proof-backed', async () => {
    const info = await createMidnightDriver().describe();
    expect(info.available).toBe(true);
    expect(info.provesMoves).toBe(true);
    expect(info.onChain).toBe(true);
  });

  it('asks for a Midnight wallet when the browser has none', async () => {
    const d = createMidnightDriver();
    // jsdom has no injected wallet: every game call fails at the connect
    // step with the player-facing Lace guidance.
    for (const method of ['newGame', 'commitFleet', 'fire', 'report', 'revealFleets']) {
      await expect(d[method](method === 'commitFleet' ? Array(64).fill(0) : undefined))
        .rejects.toThrow(/Lace|no game bound|no Midnight wallet/i);
    }
  });

  it('still supports subscribe/unsubscribe so the app can mount it', () => {
    const d = createMidnightDriver();
    const off = d.subscribe(() => {});
    expect(d.listeners.size).toBe(1);
    off();
    expect(d.listeners.size).toBe(0);
  });

  it('is listed as available by the registry', () => {
    const entry = listDrivers().find((d) => d.id === DRIVER_IDS.MIDNIGHT);
    expect(entry.available).toBe(true);
    expect(listDrivers().find((d) => d.id === DRIVER_IDS.LOCAL).available).toBe(true);
  });
});

describe('BrowserLocalDriver lifecycle', () => {
  it('describes itself honestly: no proofs, no chain', async () => {
    const info = await new BrowserLocalDriver().describe();
    expect(info.provesMoves).toBe(false);
    expect(info.onChain).toBe(false);
    expect(info.available).toBe(true);
  });

  it('walks the contract phases OPEN -> PLACED_2 -> PLAYING -> FINISHED', async () => {
    const d = new BrowserLocalDriver();
    expect((await d.getState()).phase).toBe(PHASE.OPEN);
    await d.newGame({ seed: 5 });
    expect((await d.getState()).phase).toBe(PHASE.PLACED_2); // the AI seat committed
    await d.commitFleet(fleet());
    const state = await d.getState();
    expect(state.phase).toBe(PHASE.PLAYING);
    expect(state.turn).toBe(SEAT.YOU); // p1 fires first, as in the contract
  });

  it('refuses a fleet shared/ would reject', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame();
    await expect(d.commitFleet(Array(64).fill(0))).rejects.toThrow(/exactly 7 cells/);
    await expect(d.commitFleet(Array(10).fill(1))).rejects.toThrow(/64 cells/);
  });

  it('refuses to fire before a fleet is committed', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame();
    await expect(d.fire({ x: 0, y: 0 })).rejects.toThrow(/commit your fleet first/);
  });

  it('refuses a repeat shot and an off-board shot', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame({ seed: 9 });
    await d.commitFleet(fleet());
    await d.fire({ x: 0, y: 0 });
    await expect(d.fire({ x: 0, y: 0 })).rejects.toThrow(/already fired at A1/);
    await expect(d.fire({ x: 9, y: 0 })).rejects.toThrow(/off the board/);
  });

  it('records one mark per shot and answers hit or miss', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame({ seed: 11 });
    await d.commitFleet(fleet());
    const { yours, theirs } = await d.fire({ x: 3, y: 3 });
    expect(['hit', 'miss']).toContain(yours.result);
    expect(theirs.seat).toBe(SEAT.OPPONENT);
    const state = await d.getState();
    expect(state.opponent.marks.filter((m) => m !== MARK.UNKNOWN)).toHaveLength(1);
    expect(state.you.marks.filter((m) => m !== MARK.UNKNOWN)).toHaveLength(1);
  });

  it('is deterministic: the same seed replays the same opponent shots', async () => {
    const run = async () => {
      const d = new BrowserLocalDriver();
      await d.newGame({ seed: 17, difficulty: 'hard' });
      await d.commitFleet(fleet());
      for (let i = 0; i < 6; i += 1) await d.fire(indexToCoordinate(i));
      return (await d.getShotLog()).map((e) => `${e.circuit}:${e.seat}:${e.coord?.x},${e.coord?.y}:${e.result ?? ''}`);
    };
    expect(await run()).toEqual(await run());
  });

  it('ends with a winner and the losing fleet fully hit', async () => {
    const d = new BrowserLocalDriver();
    const state = await playToFinish(d);
    expect(state.phase).toBe(PHASE.FINISHED);
    expect([SEAT.YOU, SEAT.OPPONENT]).toContain(state.winner);
    const loser = state.winner === SEAT.YOU ? state.opponent : state.you;
    expect(loser.hitsTaken).toBe(FLEET_CELLS);
    await expect(d.fire({ x: 0, y: 0 })).rejects.toThrow(/game is over/);
  });

  it('emits to subscribers and stops after unsubscribe', async () => {
    const d = new BrowserLocalDriver();
    let calls = 0;
    const off = d.subscribe(() => { calls += 1; });
    await d.newGame();
    await d.commitFleet(fleet());
    expect(calls).toBeGreaterThanOrEqual(2);
    const seen = calls;
    off();
    await d.fire({ x: 0, y: 0 });
    expect(calls).toBe(seen);
  });

  it('survives a subscriber that throws', async () => {
    const d = new BrowserLocalDriver();
    d.subscribe(() => { throw new Error('bad subscriber'); });
    await expect(d.newGame()).resolves.toBeTruthy();
  });

  it('newGame resets a finished game back to setup', async () => {
    const d = new BrowserLocalDriver();
    await playToFinish(d);
    await d.newGame({ seed: 2 });
    const state = await d.getState();
    expect(state.phase).toBe(PHASE.PLACED_2);
    expect(state.winner).toBeNull();
    expect(state.you.fleet).toBeNull();
    expect(state.opponent.marks.every((m) => m === MARK.UNKNOWN)).toBe(true);
  });
});

describe('narration through the driver', () => {
  it('produces template lines for public events only', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame({ seed: 4 });
    await d.commitFleet(fleet());
    await d.fire({ x: 2, y: 2 });
    const lines = (await d.getNarration()).map((n) => n.line);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(' ')).toMatch(/locked in their fleet/);
    expect(lines.join(' ')).toMatch(/C3/);
  });

  it('never narrates anything derived from a board', async () => {
    const seen = [];
    const narrator = { narrate: (event) => { seen.push(event); return 'line'; } };
    const d = new BrowserLocalDriver({ narrator });
    await d.newGame({ seed: 4 });
    await d.commitFleet(fleet());
    await d.fire({ x: 2, y: 2 });
    for (const event of seen) {
      expect(['commit', 'fire', 'report', 'win']).toContain(event.type);
      for (const key of Object.keys(event)) {
        expect(['type', 'player', 'coord', 'result']).toContain(key);
      }
    }
  });

  it('a narrator that throws cannot take the game down', async () => {
    const d = new BrowserLocalDriver({ narrator: { narrate() { throw new Error('nope'); } } });
    await d.newGame();
    await expect(d.commitFleet(fleet())).resolves.toBeTruthy();
    expect(await d.getNarration()).toEqual([]);
  });
});

describe('displayCommitment', () => {
  it('is stable for the same board and salt, and differs for a changed board', () => {
    const board = fleet();
    const salt = Array(32).fill(7);
    expect(displayCommitment(board, salt)).toBe(displayCommitment(board, salt));
    const moved = [...board];
    const on = moved.indexOf(1);
    const off = moved.indexOf(0);
    [moved[on], moved[off]] = [moved[off], moved[on]];
    expect(displayCommitment(moved, salt)).not.toBe(displayCommitment(board, salt));
  });
});
