// THE FOG-OF-WAR PROPERTY.
//
// This is a privacy test, not a feature test. The whole product claim is that
// the opponent's fleet is not knowable until you have shot at it, and the UI is
// the easiest place to break that claim by accident - a debug field, a cached
// board, a "ships remaining" hint. These tests assert the property directly:
//
//   1. nothing the driver hands the UI reveals an unfired opponent cell;
//   2. the opponent's board is not merely unrendered but unreachable (#private);
//   3. the one legitimate exit, revealFleets(), is gated on FINISHED;
//   4. the property survives a whole game, checked after every single round.
//
// The assertions run through the driver *interface*, so the proof-backed driver
// inherits this suite when it lands.
import { describe, expect, it } from 'vitest';
import { BrowserLocalDriver } from '../src/game/local-driver.js';
import { GRID_CELLS, MARK, PHASE, SEAT, indexToCoordinate, randomFleet } from '../src/game/protocol.js';
import { mulberry32 } from '../../ai/opponent.js';
import { render, screen } from '@testing-library/react';
import { Board } from '../src/components/Board.jsx';

const myFleet = () => randomFleet(mulberry32(99));

/** Collect every array of exactly 64 entries anywhere in a value. */
function collectBoardShapedArrays(value, found = [], seen = new Set()) {
  if (value === null || typeof value !== 'object') return found;
  if (seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length === GRID_CELLS) found.push(value);
    for (const item of value) collectBoardShapedArrays(item, found, seen);
    return found;
  }
  for (const item of Object.values(value)) collectBoardShapedArrays(item, found, seen);
  return found;
}

/**
 * The core assertion: given the public state and the set of cells the player
 * has actually fired at, nothing in that state distinguishes an unfired
 * opponent ship cell from unfired open water.
 */
function assertNoLeak(state, firedIndices, hiddenFleet) {
  const unfired = [];
  for (let i = 0; i < GRID_CELLS; i += 1) if (!firedIndices.has(i)) unfired.push(i);

  // 1. every unfired opponent cell is fog
  for (const i of unfired) {
    expect(state.opponent.marks[i], `cell ${i} should be fog`).toBe(MARK.UNKNOWN);
  }
  // 2. every marked cell is one that was actually fired at
  state.opponent.marks.forEach((mark, i) => {
    if (mark !== MARK.UNKNOWN) expect(firedIndices.has(i)).toBe(true);
  });
  // 3. the opponent layout is simply absent
  expect(state.opponent.fleet).toBeNull();
  // 4. no board-shaped array anywhere in the state equals (or inverts) the hidden fleet
  for (const arr of collectBoardShapedArrays(state)) {
    expect(arr).not.toEqual(hiddenFleet);
    expect(arr).not.toEqual(hiddenFleet.map((c) => 1 - c));
  }
  // 5. and the serialized state does not contain it either
  const wire = JSON.stringify(state);
  expect(wire).not.toContain(JSON.stringify(hiddenFleet));
  // 6. hit count can never exceed what has been fired at
  expect(state.opponent.hitsTaken).toBeLessThanOrEqual(firedIndices.size);
}

describe('fog of war: the opponent board never reaches the UI unfired', () => {
  it('is fully fogged before a single shot', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame({ seed: 21 });
    await d.commitFleet(myFleet());
    const state = await d.getState();
    expect(state.opponent.marks.every((m) => m === MARK.UNKNOWN)).toBe(true);
    expect(state.opponent.fleet).toBeNull();
    expect(state.opponent.hitsTaken).toBe(0);
  });

  it('holds after every round of a complete game', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame({ seed: 21, difficulty: 'medium' });
    await d.commitFleet(myFleet());

    // The hidden fleet, obtained the only legitimate way, at the end. We need it
    // during the game too, so play once, reveal, then replay the same seed.
    const probe = new BrowserLocalDriver();
    await probe.newGame({ seed: 21, difficulty: 'medium' });
    await probe.commitFleet(myFleet());
    const fired = new Set();
    for (let i = 0; i < GRID_CELLS; i += 1) {
      const s = await probe.getState();
      if (s.phase === PHASE.FINISHED) break;
      await probe.fire(indexToCoordinate(i));
      fired.add(i);
    }
    const hidden = (await probe.revealFleets()).opponent;
    expect(hidden.reduce((t, c) => t + c, 0)).toBe(7);

    // Now replay and check the property after every round.
    const firedNow = new Set();
    for (let i = 0; i < GRID_CELLS; i += 1) {
      const state = await d.getState();
      if (state.phase === PHASE.FINISHED) break;
      assertNoLeak(state, firedNow, hidden);
      await d.fire(indexToCoordinate(i));
      firedNow.add(i);
      assertNoLeak(await d.getState(), firedNow, hidden);
    }
    expect(firedNow.size).toBeGreaterThan(0);
  });

  it('the shot log leaks nothing beyond fired coordinates', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame({ seed: 33 });
    await d.commitFleet(myFleet());
    const fired = new Set();
    for (let i = 0; i < 12; i += 1) {
      await d.fire(indexToCoordinate(i));
      fired.add(i);
    }
    const log = await d.getShotLog();
    // Entries about the opponent's board are only report entries for cells we fired at.
    for (const entry of log) {
      if (entry.circuit === 'report' && entry.seat === SEAT.OPPONENT) {
        const idx = entry.coord.y * 8 + entry.coord.x;
        expect(fired.has(idx)).toBe(true);
      }
      expect(collectBoardShapedArrays(entry)).toEqual([]);
    }
  });

  it('narration leaks nothing: lines only ever name fired coordinates', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame({ seed: 8 });
    await d.commitFleet(myFleet());
    await d.fire({ x: 0, y: 0 });
    const text = (await d.getNarration()).map((n) => n.line).join(' ');
    const mentioned = text.match(/\b[A-H][1-8]\b/g) ?? [];
    // Only A1 (our shot) and whatever the AI fired at may appear.
    const log = await d.getShotLog();
    const firedNames = new Set(
      log.filter((e) => e.coord).map((e) => `${String.fromCharCode(65 + e.coord.x)}${e.coord.y + 1}`));
    for (const name of mentioned) expect(firedNames.has(name)).toBe(true);
  });

  it('the hidden board is unreachable, not just unrendered', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame({ seed: 12 });
    await d.commitFleet(myFleet());
    // #private class fields: no enumeration, no reflection, no serialization.
    const wire = JSON.stringify(d);
    expect(wire).not.toMatch(/opponentFleet/);
    const names = [...Object.keys(d), ...Object.getOwnPropertyNames(d)];
    for (const name of names) expect(name).not.toMatch(/opponentFleet|yourSalt|aiSalt/);
  });
});

describe('fog of war: reveal is gated', () => {
  it('refuses to open the opponent board before the game is finished', async () => {
    const d = new BrowserLocalDriver();
    await expect(d.revealFleets()).rejects.toThrow(/game not finished/);
    await d.newGame({ seed: 4 });
    await expect(d.revealFleets()).rejects.toThrow(/game not finished/);
    await d.commitFleet(myFleet());
    await d.fire({ x: 0, y: 0 });
    await expect(d.revealFleets()).rejects.toThrow(/game not finished/);
    expect((await d.getState()).opponent.fleet).toBeNull();
  });

  it('opens it once FINISHED, and only then does state carry it', async () => {
    const d = new BrowserLocalDriver();
    await d.newGame({ seed: 4, difficulty: 'easy' });
    await d.commitFleet(myFleet());
    for (let i = 0; i < GRID_CELLS; i += 1) {
      if ((await d.getState()).phase === PHASE.FINISHED) break;
      await d.fire(indexToCoordinate(i));
    }
    expect((await d.getState()).phase).toBe(PHASE.FINISHED);
    expect((await d.getState()).opponent.fleet).toBeNull(); // still closed

    const revealed = await d.revealFleets();
    expect(revealed.opponent.reduce((t, c) => t + c, 0)).toBe(7);
    expect(revealed.commitmentsMatch).toBe(true);
    const after = await d.getState();
    expect(after.revealed).toBe(true);
    expect(after.opponent.fleet).toEqual(revealed.opponent);
  });
});

describe('fog of war: the enemy <Board> cannot draw what it is not given', () => {
  it('renders every unfired enemy cell as unknown', () => {
    const marks = Array(GRID_CELLS).fill(MARK.UNKNOWN);
    marks[0] = MARK.HIT;
    marks[1] = MARK.MISS;
    render(<Board mode="enemy" fleet={null} marks={marks} caption="Enemy waters" />);
    expect(screen.getByTestId('cell-enemy-A1')).toHaveAttribute('aria-label', 'A1, hit');
    expect(screen.getByTestId('cell-enemy-B1')).toHaveAttribute('aria-label', 'B1, miss');
    for (const name of ['C1', 'D5', 'H8']) {
      expect(screen.getByTestId(`cell-enemy-${name}`)).toHaveAttribute('aria-label', `${name}, unknown`);
    }
    expect(document.querySelectorAll('.cell--ship')).toHaveLength(0);
  });

  it('draws ships on your own board, where you are entitled to see them', () => {
    const fleet = Array(GRID_CELLS).fill(0);
    fleet[0] = 1;
    render(<Board mode="mine" fleet={fleet} marks={Array(GRID_CELLS).fill(MARK.UNKNOWN)} />);
    expect(screen.getByTestId('cell-mine-A1')).toHaveAttribute('aria-label', 'A1, your ship');
    expect(screen.getByTestId('cell-mine-B1')).toHaveAttribute('aria-label', 'B1, unknown');
  });
});
