// LocalGame api tests: full game, commitment determinism, transcript replay.
import { describe, it, expect } from 'vitest';
import { LocalGame, GameError } from '../local-game.js';
import { randomFleet, indexToCoordinate, FLEET_CELLS } from '../../shared/index.js';

const P1_FLEET = (() => { const b = Array(64).fill(0); for (const i of [0, 1, 2, 8, 9, 16, 17]) b[i] = 1; return b; })();
const P2_FLEET = (() => { const b = Array(64).fill(0); for (const i of [3, 4, 5, 11, 12, 19, 20]) b[i] = 1; return b; })();
const SALT1 = new Uint8Array(32).fill(11);
const SALT2 = new Uint8Array(32).fill(22);

function startedGame() {
  const game = LocalGame.create();
  const p1 = game.addPlayer('alice');
  const p2 = game.addPlayer('bob');
  game.commitBoard(p1, P1_FLEET, SALT1);
  game.commitBoard(p2, P2_FLEET, SALT2);
  return { game, p1, p2 };
}

// p1 sinks bob's fleet while bob shoots water on alice's board
function playToWin(game, p1, p2) {
  const p2Cells = P2_FLEET.map((c, i) => (c === 1 ? i : -1)).filter((i) => i >= 0);
  let i = 0;
  for (const idx of p2Cells) {
    game.fire(p1, indexToCoordinate(idx));
    expect(game.report(p2)).toBe('hit');
    // distinct water cells on P1_FLEET's board (duplicate shots now revert)
    game.fire(p2, { x: i, y: 4 });
    expect(game.report(p1)).toBe('miss');
    i += 1;
  }
}

describe('LocalGame', () => {
  it('plays a full game to a winner with correct public state', () => {
    const { game, p1, p2 } = startedGame();
    expect(game.state().phase).toBe('PLAYING');
    expect(game.state().turn).toBe('alice');
    playToWin(game, p1, p2);
    expect(game.state().hitsLanded.alice).toBe(FLEET_CELLS);
    game.claimWin(p1);
    const end = game.state();
    expect(end.phase).toBe('FINISHED');
    expect(end.winner).toBe('alice');
  });

  it('commitment is deterministic for board+salt and salt-sensitive', () => {
    const a = LocalGame.create();
    const pa = a.addPlayer('alice');
    a.addPlayer('bob');
    const c1 = a.commitBoard(pa, P1_FLEET, SALT1);
    const b = LocalGame.create();
    const pb = b.addPlayer('alice');
    b.addPlayer('bob');
    const c2 = b.commitBoard(pb, P1_FLEET, SALT1);
    expect(c1).toBe(c2);
    const c3 = LocalGame.create();
    const pc = c3.addPlayer('alice');
    c3.addPlayer('bob');
    expect(c3.commitBoard(pc, P1_FLEET, new Uint8Array(32).fill(99))).not.toBe(c1);
  });

  it('rejects an invalid fleet before touching the contract', () => {
    const game = LocalGame.create();
    const p1 = game.addPlayer('alice');
    expect(() => game.commitBoard(p1, Array(64).fill(0))).toThrow(/exactly 7 cells/);
  });

  it('maps contract reverts to GameError with the assert text', () => {
    const { game, p2 } = startedGame();
    expect(() => game.fire(p2, { x: 0, y: 0 })).toThrow(GameError);
    expect(() => game.fire(p2, { x: 0, y: 0 })).toThrow('not your turn');
  });

  it('shot log replays to the identical final state', () => {
    const { game, p1, p2 } = startedGame();
    playToWin(game, p1, p2);
    game.claimWin(p1);
    const original = game.state();
    const replica = LocalGame.replay(game.shotLog()).state();
    expect(replica).toEqual(original);
  });


  it('commitment is board-sensitive (same salt, moved ship)', () => {
    const moved = [...P1_FLEET]; moved[0] = 0; moved[63] = 1;
    const a = LocalGame.create();
    const pa = a.addPlayer('alice');
    a.addPlayer('bob');
    const b = LocalGame.create();
    const pb = b.addPlayer('alice');
    b.addPlayer('bob');
    expect(a.commitBoard(pa, P1_FLEET, SALT1)).not.toBe(b.commitBoard(pb, moved, SALT1));
  });

  it('shot log survives a JSON round-trip and replays identically', () => {
    const { game, p1, p2 } = startedGame();
    playToWin(game, p1, p2);
    game.claimWin(p1);
    const json = JSON.stringify(game.shotLog());
    const replica = LocalGame.replay(JSON.parse(json)).state();
    expect(replica).toEqual(game.state());
  });


  it('revealBoard marks only the revealer post-game and replays', () => {
    const { game, p1, p2 } = startedGame();
    playToWin(game, p1, p2);
    game.claimWin(p1);
    expect(() => game.revealBoard(p1)).not.toThrow();
    const st = game.state();
    expect(st.revealed.alice).toBe(true);
    expect(st.revealed.bob).toBe(false);
    expect(() => game.revealBoard(p1)).not.toThrow(); // idempotent
    const replica = LocalGame.replay(JSON.parse(JSON.stringify(game.shotLog()))).state();
    expect(replica).toEqual(st);
  });

  it('revealBoard before the game ends is a GameError', () => {
    const { game, p1 } = startedGame();
    expect(() => game.revealBoard(p1)).toThrow(GameError);
    expect(() => game.revealBoard(p1)).toThrow('game not finished');
  });

  it('random fleets from shared/ pass contract Tier B validity', () => {
    const game = LocalGame.create();
    const p1 = game.addPlayer('alice');
    const p2 = game.addPlayer('bob');
    expect(() => game.commitBoard(p1, randomFleet())).not.toThrow();
    expect(() => game.commitBoard(p2, randomFleet())).not.toThrow();
    expect(game.state().phase).toBe('PLAYING');
  });
});
