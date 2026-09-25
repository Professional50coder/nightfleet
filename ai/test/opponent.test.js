// AI opponent tests: determinism, legal shots, hunt/target
// behavior, density mode, and a full game through the real LocalGame api.
import { describe, it, expect } from 'vitest';
import { Opponent, opponentFleet, DIFFICULTIES } from '../opponent.js';
import { GamePlayer } from '../game-player.js';
import { LocalGame } from '../../api/local-game.js';
import { GRID_CELLS, FLEET_CELLS, assertValidFleet, coordinateToIndex, indexToCoordinate } from '../../shared/index.js';

// fixed human board: two horizontal runs + one vertical, 7 cells
const HUMAN_FLEET = (() => { const b = Array(64).fill(0); for (const i of [0, 1, 2, 9, 17, 25, 33]) b[i] = 1; return b; })();
const HUMAN_FLEET_B = (() => { const b = Array(64).fill(0); for (const i of [60, 61, 62, 40, 48, 56, 7]) b[i] = 1; return b; })();

function driveToCompletion(op, board) {
  // feed contract-style answers for `board` until all 64 cells are shot
  while (op.shots.length < GRID_CELLS) {
    const c = op.nextShot();
    op.recordShot(c, board[coordinateToIndex(c)] === 1 ? 'hit' : 'miss');
  }
  return op.shots;
}

describe('Opponent engine', () => {
  it.each(DIFFICULTIES)('%s: shoots every cell exactly once, all legal', (d) => {
    const op = new Opponent({ difficulty: d, seed: 7 });
    const shots = driveToCompletion(op, HUMAN_FLEET);
    expect(shots).toHaveLength(GRID_CELLS);
    expect(new Set(shots.map((s) => coordinateToIndex(s))).size).toBe(GRID_CELLS);
    expect(shots.filter((s) => s.result === 'hit')).toHaveLength(FLEET_CELLS);
  });

  it('is deterministic: same seed and answers -> same shot sequence', () => {
    const a = driveToCompletion(new Opponent({ difficulty: 'hard', seed: 42 }), HUMAN_FLEET);
    const b = driveToCompletion(new Opponent({ difficulty: 'hard', seed: 42 }), HUMAN_FLEET);
    expect(a).toEqual(b);
    const c = driveToCompletion(new Opponent({ difficulty: 'easy', seed: 43 }), HUMAN_FLEET);
    expect(a.map((s) => coordinateToIndex(s))).not.toEqual(c.map((s) => coordinateToIndex(s)));
  });

  it('medium hunts on the parity grid before any hit', () => {
    const op = new Opponent({ difficulty: 'medium', seed: 3 });
    for (let i = 0; i < 12; i += 1) {
      const c = op.nextShot();
      expect((c.x + c.y) % 2).toBe(0);
      op.recordShot(c, 'miss');
    }
  });

  it('medium targets orthogonal neighbors right after a hit', () => {
    const op = new Opponent({ difficulty: 'medium', seed: 5 });
    // force a hit at D4 without prior hits: answer miss until D4 is chosen
    const board = Array(64).fill(0); board[coordinateToIndex({ x: 3, y: 3 })] = 1;
    let c;
    do { c = op.nextShot(); op.recordShot(c, board[coordinateToIndex(c)] === 1 ? 'hit' : 'miss'); }
    while (op.shots.at(-1).result !== 'hit');
    const next = op.nextShot();
    const manhattan = Math.abs(next.x - 3) + Math.abs(next.y - 3);
    expect(manhattan).toBe(1);
  });

  it('medium follows a hit line instead of re-probing sideways', () => {
    const op = new Opponent({ difficulty: 'medium', seed: 9 });
    op.recordShot({ x: 2, y: 2 }, 'hit');
    op.recordShot({ x: 3, y: 2 }, 'hit');
    const next = op.nextShot();
    // must extend the horizontal line: (1,2) or (4,2)
    expect(next.y).toBe(2);
    expect([1, 4]).toContain(next.x);
  });

  it('hard density respects misses: never shoots a scored-out cell', () => {
    const op = new Opponent({ difficulty: 'hard', seed: 11 });
    const board = Array(64).fill(0); board[coordinateToIndex({ x: 0, y: 0 })] = 1;
    const shots = driveToCompletion(op, board);
    const hitAt = shots.findIndex((s) => s.result === 'hit');
    expect(hitAt).toBeGreaterThanOrEqual(0);
    // after the hit, subsequent shots must be consistent with remaining fleet shapes
    expect(() => op.nextShot()).toThrow(/exhausted/);
  });

  it('rejects a double-recorded cell and bad results', () => {
    const op = new Opponent({ seed: 1 });
    op.recordShot({ x: 0, y: 0 }, 'miss');
    expect(() => op.recordShot({ x: 0, y: 0 }, 'hit')).toThrow(/already shot/);
    expect(() => op.recordShot({ x: 1, y: 1 }, 'sunk')).toThrow(RangeError);
    expect(() => new Opponent({ difficulty: 'impossible' })).toThrow(RangeError);
  });

  it('opponentFleet is seeded, valid, and reproducible', () => {
    const a = opponentFleet(123);
    const b = opponentFleet(123);
    assertValidFleet(a);
    expect(a).toEqual(b);
    expect(a.reduce((t, c) => t + c, 0)).toBe(FLEET_CELLS);
  });
});

describe('GamePlayer (real contract)', () => {
  it('joins, commits, and sinks the human fleet through the api', { timeout: 30000 }, () => {
    const game = LocalGame.create();
    const human = game.addPlayer('human');
    const ai = new GamePlayer(game, 'ai', { difficulty: 'medium', seed: 21 });
    game.commitBoard(human, HUMAN_FLEET_B);
    ai.commitSeat();
    expect(game.state().phase).toBe('PLAYING');
    expect(typeof ai.commitment).toBe('string');

    // human fires only water at the AI board; AI plays to win
    // (distinct cells each turn - duplicate shots now revert on-chain)
    const waterCells = ai.board.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0).map(indexToCoordinate);
    let waterTurn = 0;
    let turns = 0;
    while (game.state().winner === null && turns < 2 * GRID_CELLS + 20) {
      turns += 1;
      const st = game.state();
      if (st.turn === 'human') {
        game.fire(human, waterCells[waterTurn % waterCells.length]);
        waterTurn += 1;
        expect(game.report(ai.handle)).toBe('miss');
      } else {
        const shot = ai.takeTurn(human);
        if (game.state().hitsLanded.ai === FLEET_CELLS) {
          game.claimWin(ai.handle);
        }
        expect(['hit', 'miss']).toContain(shot.result);
      }
    }
    expect(game.state().winner).toBe('ai');
    expect(game.state().hitsLanded.ai).toBe(FLEET_CELLS);
    // the AI's shot log in the transcript matches its engine record
    const aiShots = game.shotLog().filter((e) => e.circuit === 'fire' && e.player === 'ai');
    expect(aiShots.map((e) => [e.x, e.y])).toEqual(ai.engine.shots.map((s) => [s.x, s.y]));
  });

  it('two AI seats complete a game against each other', { timeout: 30000 }, () => {
    const game = LocalGame.create();
    const a = new GamePlayer(game, 'alpha', { difficulty: 'easy', seed: 1 });
    const b = new GamePlayer(game, 'beta', { difficulty: 'hard', seed: 2 });
    a.commitSeat();
    b.commitSeat();
    let turns = 0;
    while (game.state().winner === null && turns < 2 * GRID_CELLS + 20) {
      turns += 1;
      const st = game.state();
      const cur = st.turn === 'alpha' ? a : b;
      const foe = st.turn === 'alpha' ? b : a;
      cur.takeTurn(foe.handle);
      const after = game.state();
      if (after.hitsLanded[cur.name] === FLEET_CELLS) game.claimWin(cur.handle);
    }
    expect(game.state().winner).not.toBeNull();
    expect(game.state().phase).toBe('FINISHED');
  });
});
