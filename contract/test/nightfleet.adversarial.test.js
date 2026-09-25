// NightFleet adversarial + happy-path circuit tests.
// Every cheating attempt MUST revert with the contract's assert message.
import { describe, it, expect } from 'vitest';
import { Contract, ledger, Phase } from '../managed/contract/index.js';
import { createConstructorContext, createCircuitContext } from '@midnight-ntwrk/compact-runtime';
import { sampleContractAddress } from '@midnight-ntwrk/onchain-runtime-v3';

const ADDRESS = sampleContractAddress();
const COIN_PK = '0'.repeat(64);

// p1 fleet: idx 0,1,2 (row 0), 8,9 (row 1), 16,17 (row 2)
// p2 fleet: idx 3,4,5 (row 0), 11,12 (row 1), 19,20 (row 2)
function mkPriv(seed, fleetIdx) {
  const board = Array(64).fill(0n);
  for (const i of fleetIdx) board[i] = 1n;
  return {
    sk: new Uint8Array(32).fill(seed),
    salt: new Uint8Array(32).fill(seed + 100),
    board,
  };
}

const witnesses = {
  localSecretKey: (ctx) => [ctx.privateState, ctx.privateState.sk],
  myBoard: (ctx) => [ctx.privateState, ctx.privateState.board],
  mySalt: (ctx) => [ctx.privateState, ctx.privateState.salt],
};

function freshGame() {
  const contract = new Contract(witnesses);
  const p1 = mkPriv(1, [0, 1, 2, 8, 9, 16, 17]);
  const p2 = mkPriv(2, [3, 4, 5, 11, 12, 19, 20]);
  const { currentContractState } = contract.initialState(createConstructorContext(p1, COIN_PK));
  return { contract, state: currentContractState, p1, p2 };
}

function run(game, priv, circuit, ...args) {
  const ctx = createCircuitContext(ADDRESS, COIN_PK, game.state, priv);
  const res = game.contract.impureCircuits[circuit](ctx, ...args);
  game.state = res.context.currentQueryContext.state;
  return res;
}

// Same as `run`, but pins the block clock the circuit sees to `time` (unix
// seconds). createCircuitContext takes it as its 7th argument and writes it
// into QueryContext.block.secondsSinceEpoch - the same field the chain fills
// in for real, and the one kernel.blockTime{Greater,Less}Than reads.
function runAt(game, priv, time, circuit, ...args) {
  const ctx = createCircuitContext(ADDRESS, COIN_PK, game.state, priv, undefined, undefined, time);
  const res = game.contract.impureCircuits[circuit](ctx, ...args);
  game.state = res.context.currentQueryContext.state;
  return res;
}

const led = (game) => ledger(game.state.data ?? game.state);
const ZERO = new Uint8Array(32);

// joined + committed game in PLAYING phase, turn = p1
function startedGame() {
  const g = freshGame();
  run(g, g.p1, 'joinGame');
  run(g, g.p2, 'joinGame');
  run(g, g.p1, 'commitBoard');
  run(g, g.p2, 'commitBoard');
  return g;
}

// game played to FINISHED: p1 sinks p2's fleet, p2 shoots water, p1 claims
function finishedGame() {
  const g = startedGame();
  const p2FleetIdx = [3, 4, 5, 11, 12, 19, 20];
  let i = 0;
  for (const idx of p2FleetIdx) {
    run(g, g.p1, 'fire', BigInt(idx % 8), BigInt(Math.floor(idx / 8)));
    run(g, g.p2, 'report'); // hit
    // distinct water cells on p1's board (duplicate shots now revert)
    run(g, g.p2, 'fire', BigInt(i), 4n);
    run(g, g.p1, 'report'); // miss
    i += 1;
  }
  run(g, g.p1, 'claimWin');
  return g;
}

describe('happy path', () => {
  it('constructor: OPEN, no winner, no pending shot, zero hits', () => {
    const g = freshGame();
    const l = led(g);
    expect(l.phase).toBe(Phase.OPEN);
    expect(l.winner.is_some).toBe(false);
    expect(l.pendingShot.is_some).toBe(false);
    expect(l.hits1).toBe(0n);
    expect(l.hits2).toBe(0n);
  });

  it('joinGame registers p1 then p2, stays OPEN', () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    const l1 = led(g);
    expect(l1.p1).not.toEqual(ZERO);
    expect(l1.phase).toBe(Phase.OPEN);
    run(g, g.p2, 'joinGame');
    const l2 = led(g);
    expect(l2.p2).not.toEqual(ZERO);
    expect(l2.p2).not.toEqual(l2.p1);
  });

  it('commitBoard p1 sets commitment and PLACED_1', () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    run(g, g.p2, 'joinGame');
    run(g, g.p1, 'commitBoard');
    const l = led(g);
    expect(l.commitment1).not.toEqual(ZERO);
    expect(l.commitment2).toEqual(ZERO);
    expect(l.phase).toBe(Phase.PLACED_1);
  });

  it('commitBoard p2 moves to PLAYING, turn = p1', () => {
    const g = startedGame();
    const l = led(g);
    expect(l.commitment2).not.toEqual(ZERO);
    expect(l.phase).toBe(Phase.PLAYING);
    expect(l.turn).toEqual(l.p1);
  });

  it('fire records the pending shot', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);
    const l = led(g);
    expect(l.pendingShot.is_some).toBe(true);
    expect(l.pendingShot.value).toEqual({ x: 3n, y: 0n });
  });

  it('report hit increments hits against defender, clears shot, flips turn', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n); // p2 has a ship at idx 3
    run(g, g.p2, 'report');
    const l = led(g);
    expect(l.hits2).toBe(1n);
    expect(l.hits1).toBe(0n);
    expect(l.pendingShot.is_some).toBe(false);
    expect(l.turn).toEqual(l.p2);
  });

  it('report miss does not increment, flips turn', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 7n, 7n); // idx 63: water on p2 board
    run(g, g.p2, 'report');
    expect(led(g).hits2).toBe(0n);
    run(g, g.p2, 'fire', 7n, 7n); // water on p1 board too
    run(g, g.p1, 'report');
    const l = led(g);
    expect(l.hits1).toBe(0n);
    expect(l.turn).toEqual(l.p1);
  });

  it('mux cellAt: hit on late cell (idx 20) and corner (idx 0)', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 4n, 2n); // idx 20: p2 ship
    run(g, g.p2, 'report');
    expect(led(g).hits2).toBe(1n);
    run(g, g.p2, 'fire', 0n, 0n); // idx 0: p1 ship
    run(g, g.p1, 'report');
    expect(led(g).hits1).toBe(1n);
  });

  it('full game: 7 hits then claimWin finalizes with winner = attacker', () => {
    const g = startedGame();
    const p2Fleet = [[3, 0], [4, 0], [5, 0], [3, 1], [4, 1], [3, 2], [4, 2]];
    let i = 0;
    for (const [x, y] of p2Fleet) {
      run(g, g.p1, 'fire', BigInt(x), BigInt(y));
      run(g, g.p2, 'report'); // hit
      run(g, g.p2, 'fire', BigInt(i), 4n); // distinct water (duplicate shots revert)
      run(g, g.p1, 'report'); // miss
      i += 1;
    }
    expect(led(g).hits2).toBe(7n);
    run(g, g.p1, 'claimWin');
    const l = led(g);
    expect(l.phase).toBe(Phase.FINISHED);
    expect(l.winner.is_some).toBe(true);
    expect(l.winner.value).toEqual(l.p1);
  });

  it('hit counters are independent per defender', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);
    run(g, g.p2, 'report');
    run(g, g.p2, 'fire', 0n, 0n);
    run(g, g.p1, 'report');
    const l = led(g);
    expect(l.hits1).toBe(1n); // hit against p1
    expect(l.hits2).toBe(1n); // hit against p2
  });

  it('revealBoard after FINISHED marks only the caller as revealed', () => {
    const g = finishedGame();
    expect(led(g).phase).toBe(Phase.FINISHED);
    run(g, g.p1, 'revealBoard');
    expect(led(g).revealed1).toBe(true);
    expect(led(g).revealed2).toBe(false);
    run(g, g.p2, 'revealBoard');
    expect(led(g).revealed2).toBe(true);
  });
});

describe('adversarial: every cheat must revert', () => {
  it('commitBoard with under-sized fleet (6 cells)', () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    run(g, g.p2, 'joinGame');
    const small = mkPriv(1, [0, 1, 2, 8, 9, 16]);
    expect(() => run(g, small, 'commitBoard')).toThrow('invalid fleet size');
  });

  it('commitBoard with over-sized fleet (8 cells)', () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    run(g, g.p2, 'joinGame');
    const big = mkPriv(1, [0, 1, 2, 8, 9, 16, 17, 24]);
    expect(() => run(g, big, 'commitBoard')).toThrow('invalid fleet size');
  });

  it('joinGame twice as the same player', () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    expect(() => run(g, g.p1, 'joinGame')).toThrow('already joined as p1');
  });

  it('joinGame as a third player on a full game', () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    run(g, g.p2, 'joinGame');
    const p3 = mkPriv(3, [0, 1, 2, 8, 9, 16, 17]);
    expect(() => run(g, p3, 'joinGame')).toThrow('game is full');
  });

  it('joinGame after the game started', () => {
    const g = startedGame();
    const p3 = mkPriv(3, [0, 1, 2, 8, 9, 16, 17]);
    expect(() => run(g, p3, 'joinGame')).toThrow('game already started');
  });

  it('fire before PLAYING phase', () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    expect(() => run(g, g.p1, 'fire', 0n, 0n)).toThrow('not in play');
  });

  it('fire out of turn', () => {
    const g = startedGame();
    expect(() => run(g, g.p2, 'fire', 0n, 0n)).toThrow('not your turn');
  });

  it('fire while a shot is pending', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);
    // turn only flips on report; p1 firing again must fail on pending shot.
    // but turn == p1 still, so the pending guard is what fires:
    expect(() => run(g, g.p1, 'fire', 4n, 0n)).toThrow('resolve the pending shot first');
  });

  it('fire out of bounds (x = 8)', () => {
    const g = startedGame();
    expect(() => run(g, g.p1, 'fire', 8n, 0n)).toThrow('out of bounds');
  });

  it('fire out of bounds (y = 8)', () => {
    const g = startedGame();
    expect(() => run(g, g.p1, 'fire', 0n, 8n)).toThrow('out of bounds');
  });

  it('report by the attacker (not the defender)', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);
    expect(() => run(g, g.p1, 'report')).toThrow('attacker cannot report');
  });

  it('report with no pending shot', () => {
    const g = startedGame();
    expect(() => run(g, g.p2, 'report')).toThrow('no pending shot');
  });

  it('report with a moved board (same salt, different board)', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);
    const cheater = { ...g.p2, board: mkPriv(2, [30, 31, 32, 33, 34, 35, 36]).board };
    expect(() => run(g, cheater, 'report')).toThrow('board mismatch');
  });

  it('report with the wrong salt (same board)', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);
    const cheater = { ...g.p2, salt: new Uint8Array(32).fill(9) };
    expect(() => run(g, cheater, 'report')).toThrow('board mismatch');
  });

  it('claimWin before the opponent fleet is sunk', () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);
    run(g, g.p2, 'report'); // one hit only
    expect(() => run(g, g.p1, 'claimWin')).toThrow('opponent fleet is not sunk');
  });

  it('claimWin outside PLAYING phase', () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    expect(() => run(g, g.p1, 'claimWin')).toThrow('not in play');
  });

  it('commitBoard by a non-player', () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    run(g, g.p2, 'joinGame');
    const p3 = mkPriv(3, [0, 1, 2, 8, 9, 16, 17]);
    expect(() => run(g, p3, 'commitBoard')).toThrow('not a player');
  });

  it('commitBoard again by the same player (re-commit to move ships)', () => {
    const g = startedGame();
    expect(() => run(g, g.p1, 'commitBoard')).toThrow('board already committed');
    expect(() => run(g, g.p2, 'commitBoard')).toThrow('board already committed');
  });

  it('revealBoard before the game is finished', () => {
    const g = startedGame();
    expect(() => run(g, g.p1, 'revealBoard')).toThrow('game not finished');
  });

  it('revealBoard with a moved board after FINISHED', () => {
    const g = finishedGame();
    const cheater = { ...g.p1, board: mkPriv(1, [40, 41, 42, 43, 44, 45, 46]).board };
    expect(() => run(g, cheater, 'revealBoard')).toThrow('board mismatch');
  });
});

describe('P0 soundness: duplicate-shot guard', () => {
  it('firing the same cell twice reverts', { timeout: 30000 }, () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);           // p2 ship cell (idx 3)
    run(g, g.p2, 'report');                 // hit
    run(g, g.p2, 'fire', 7n, 7n);           // p2 water shot
    run(g, g.p1, 'report');                 // miss
    expect(() => run(g, g.p1, 'fire', 3n, 0n)).toThrow(/cell already fired/);
  });

  it('a win attempted via repeated shots reverts', { timeout: 30000 }, () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);
    run(g, g.p2, 'report');                 // hit -> hits2 = 1
    run(g, g.p2, 'fire', 7n, 7n);
    run(g, g.p1, 'report');
    for (let i = 0; i < 6; i++) {
      expect(() => run(g, g.p1, 'fire', 3n, 0n)).toThrow(/cell already fired/);
    }
    expect(() => run(g, g.p1, 'claimWin')).toThrow(/opponent fleet is not sunk/);
    const l = led(g);
    expect(l.hits2).toBe(1n);               // repeats never incremented hits
  });
});

describe('P0 soundness: join/commit ordering', () => {
  it('commit before both seats are filled reverts', { timeout: 30000 }, () => {
    const g = freshGame();
    run(g, g.p1, 'joinGame');
    expect(() => run(g, g.p1, 'commitBoard')).toThrow(/both players must join first/);
  });

  it('both commit orderings reach PLAYING', { timeout: 30000 }, () => {
    const a = freshGame();
    run(a, a.p1, 'joinGame'); run(a, a.p2, 'joinGame');
    run(a, a.p1, 'commitBoard'); run(a, a.p2, 'commitBoard');
    expect(led(a).phase).toBe(Phase.PLAYING);

    const b = freshGame();
    run(b, b.p1, 'joinGame'); run(b, b.p2, 'joinGame');
    run(b, b.p2, 'commitBoard'); run(b, b.p1, 'commitBoard');
    expect(led(b).phase).toBe(Phase.PLAYING);
  });
});

// A key that never called joinGame. Same fleet shape as p1 so that, if the
// contract ever let it play, it would be a valid board - the only thing
// stopping it must be seat identity.
const stranger = () => mkPriv(9, [0, 1, 2, 8, 9, 16, 17]);

// p2 sinks p1's fleet but has not claimed yet; turn is back with p1.
function p1FleetSunk() {
  const g = startedGame();
  let water = 0;
  for (const idx of [0, 1, 2, 8, 9, 16, 17]) {
    run(g, g.p1, 'fire', BigInt(water), 5n);   // p1 shoots water
    run(g, g.p2, 'report');                    // miss
    run(g, g.p2, 'fire', BigInt(idx % 8), BigInt(Math.floor(idx / 8)));
    run(g, g.p1, 'report');                    // hit on p1
    water += 1;
  }
  return g;
}

describe('P0 soundness: only seated players may act', () => {
  it('p1 fleet is sunk and the game is still claimable', { timeout: 60000 }, () => {
    const g = p1FleetSunk();
    const l = led(g);
    expect(l.hits1).toBe(7n);          // 7 hits landed against p1
    expect(l.phase).toBe(Phase.PLAYING);
    expect(l.winner.is_some).toBe(false);
  });

  it('a stranger cannot steal the win from the player who earned it', { timeout: 60000 }, () => {
    const g = p1FleetSunk();
    // Before the fix `oppHits` fell through to the non-p1 branch for ANY key,
    // so this call succeeded and recorded a non-player as winner.
    expect(() => run(g, stranger(), 'claimWin')).toThrow(/not a player/);
    const l = led(g);
    expect(l.winner.is_some).toBe(false);
    expect(l.phase).toBe(Phase.PLAYING);
  });

  it('the rightful winner can still claim after the stranger is rejected', { timeout: 60000 }, () => {
    const g = p1FleetSunk();
    expect(() => run(g, stranger(), 'claimWin')).toThrow(/not a player/);
    run(g, g.p2, 'claimWin');
    const l = led(g);
    expect(l.phase).toBe(Phase.FINISHED);
    expect(l.winner.is_some).toBe(true);
    expect(Buffer.from(l.winner.value).toString('hex'))
      .toBe(Buffer.from(l.p2).toString('hex'));
  });

  it('a stranger cannot report a pending shot', { timeout: 60000 }, () => {
    const g = startedGame();
    run(g, g.p1, 'fire', 3n, 0n);              // p1 fires at a p2 ship cell
    expect(() => run(g, stranger(), 'report')).toThrow(/not a player/);
    expect(led(g).pendingShot.is_some).toBe(true);   // shot still unresolved
  });

  it('a stranger cannot join a full game', { timeout: 30000 }, () => {
    const g = startedGame();
    expect(() => run(g, stranger(), 'joinGame')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// P1 liveness: forfeit an unanswered shot.
//
// Compact 0.31.1 exposes no way to READ the clock - kernel has only the
// predicates blockTimeGreaterThan / blockTimeLessThan - so the deadline is
// supplied by the claimant and bracketed on-chain into
// [now + GRACE, now + MAX]. These tests drive the block clock directly via
// runAt(), which writes the same field the node fills in from the block.
const GRACE = 3600;        // TIMEOUT_GRACE_SECONDS in the contract
const MAXW = 604800;       // TIMEOUT_MAX_SECONDS in the contract
const T0 = 1800000000;     // a fixed "now", in unix seconds

// p1 fires at a p2 ship cell and p2 never reports: the board is stuck.
function stalledGame() {
  const g = startedGame();
  run(g, g.p1, 'fire', 3n, 0n);
  return g;
}

describe('P1 liveness: unanswered shot can be forfeited', () => {
  it('a stalled game is genuinely stuck before any timeout is armed', { timeout: 30000 }, () => {
    const g = stalledGame();
    const l = led(g);
    expect(l.phase).toBe(Phase.PLAYING);
    expect(l.pendingShot.is_some).toBe(true);
    expect(l.timeoutDeadline.is_some).toBe(false);
    expect(l.winner.is_some).toBe(false);
    // and the attacker cannot simply declare victory
    expect(() => run(g, g.p1, 'claimWin')).toThrow(/opponent fleet is not sunk/);
  });

  it('honest case: clock armed, deadline passes, the waiting attacker wins', { timeout: 30000 }, () => {
    const g = stalledGame();
    const deadline = BigInt(T0 + GRACE + 60);
    runAt(g, g.p1, T0, 'startTimeout', deadline);
    const armed = led(g);
    expect(armed.timeoutDeadline.is_some).toBe(true);
    expect(armed.timeoutDeadline.value).toBe(deadline);
    expect(armed.phase).toBe(Phase.PLAYING);

    runAt(g, g.p1, T0 + GRACE + 61, 'claimTimeout');
    const l = led(g);
    expect(l.phase).toBe(Phase.FINISHED);
    expect(l.winner.is_some).toBe(true);
    expect(Buffer.from(l.winner.value).toString('hex'))
      .toBe(Buffer.from(l.p1).toString('hex'));
  });

  it('claiming before the deadline reverts, and the game stays live', { timeout: 30000 }, () => {
    const g = stalledGame();
    const deadline = BigInt(T0 + GRACE + 60);
    runAt(g, g.p1, T0, 'startTimeout', deadline);
    expect(() => runAt(g, g.p1, T0 + GRACE, 'claimTimeout')).toThrow(/timeout has not expired/);
    // exactly at the deadline is still not "greater than" it
    expect(() => runAt(g, g.p1, T0 + GRACE + 60, 'claimTimeout')).toThrow(/timeout has not expired/);
    const l = led(g);
    expect(l.phase).toBe(Phase.PLAYING);
    expect(l.winner.is_some).toBe(false);
  });

  it('a deadline inside the grace window is rejected outright', { timeout: 30000 }, () => {
    const g = stalledGame();
    // one second short of the floor: this is the race-an-honest-defender attack
    expect(() => runAt(g, g.p1, T0, 'startTimeout', BigInt(T0 + GRACE - 1)))
      .toThrow(/deadline too soon/);
    expect(() => runAt(g, g.p1, T0, 'startTimeout', BigInt(T0 + 1)))
      .toThrow(/deadline too soon/);
    expect(led(g).timeoutDeadline.is_some).toBe(false);
  });

  it('a deadline past the ceiling is rejected', { timeout: 30000 }, () => {
    const g = stalledGame();
    expect(() => runAt(g, g.p1, T0, 'startTimeout', BigInt(T0 + MAXW + 1)))
      .toThrow(/deadline too far in the future/);
    expect(led(g).timeoutDeadline.is_some).toBe(false);
  });

  it('a relative (non-epoch) deadline is rejected', { timeout: 30000 }, () => {
    const g = stalledGame();
    expect(() => runAt(g, g.p1, T0, 'startTimeout', 3600n))
      .toThrow(/deadline must be absolute unix seconds/);
  });

  it('the defender cannot arm or claim a clock against the attacker', { timeout: 30000 }, () => {
    const g = stalledGame();
    expect(() => runAt(g, g.p2, T0, 'startTimeout', BigInt(T0 + GRACE + 60)))
      .toThrow(/only the waiting attacker may start the clock/);
    runAt(g, g.p1, T0, 'startTimeout', BigInt(T0 + GRACE + 60));
    expect(() => runAt(g, g.p2, T0 + GRACE + 61, 'claimTimeout'))
      .toThrow(/only the waiting attacker may claim a timeout/);
    expect(led(g).winner.is_some).toBe(false);
  });

  it('a stranger cannot arm or claim a timeout', { timeout: 30000 }, () => {
    const g = stalledGame();
    expect(() => runAt(g, stranger(), T0, 'startTimeout', BigInt(T0 + GRACE + 60)))
      .toThrow(/not a player/);
    runAt(g, g.p1, T0, 'startTimeout', BigInt(T0 + GRACE + 60));
    expect(() => runAt(g, stranger(), T0 + GRACE + 61, 'claimTimeout'))
      .toThrow(/not a player/);
    const l = led(g);
    expect(l.winner.is_some).toBe(false);
    expect(l.phase).toBe(Phase.PLAYING);
  });

  it('no pending shot means nothing to time out', { timeout: 30000 }, () => {
    const g = startedGame();
    expect(() => runAt(g, g.p1, T0, 'startTimeout', BigInt(T0 + GRACE + 60)))
      .toThrow(/no pending shot/);
    expect(() => runAt(g, g.p1, T0, 'claimTimeout')).toThrow(/no pending shot/);
  });

  it('claimTimeout with a pending shot but no armed clock reverts', { timeout: 30000 }, () => {
    const g = stalledGame();
    expect(() => runAt(g, g.p1, T0 + MAXW, 'claimTimeout')).toThrow(/no timeout running/);
  });

  it('the clock cannot be re-armed while one is running', { timeout: 30000 }, () => {
    const g = stalledGame();
    runAt(g, g.p1, T0, 'startTimeout', BigInt(T0 + GRACE + 60));
    expect(() => runAt(g, g.p1, T0 + 10, 'startTimeout', BigInt(T0 + GRACE + 10)))
      .toThrow(/timeout already running/);
    expect(led(g).timeoutDeadline.value).toBe(BigInt(T0 + GRACE + 60));
  });

  it('reporting in time disarms the clock and the game carries on', { timeout: 30000 }, () => {
    const g = stalledGame();
    runAt(g, g.p1, T0, 'startTimeout', BigInt(T0 + GRACE + 60));
    runAt(g, g.p2, T0 + 30, 'report');            // defender answers in time
    const l = led(g);
    expect(l.timeoutDeadline.is_some).toBe(false);
    expect(l.pendingShot.is_some).toBe(false);
    expect(l.hits2).toBe(1n);
    expect(l.turn).toEqual(l.p2);
    expect(l.phase).toBe(Phase.PLAYING);
    // the expired deadline is gone: no late claim off the answered shot
    expect(() => runAt(g, g.p1, T0 + MAXW, 'claimTimeout')).toThrow(/no pending shot/);
    // and the next shot starts with a clean clock
    run(g, g.p2, 'fire', 0n, 0n);
    expect(led(g).timeoutDeadline.is_some).toBe(false);
    expect(() => runAt(g, g.p2, T0 + MAXW, 'claimTimeout')).toThrow(/no timeout running/);
  });

  it('a finished game cannot be timed out', { timeout: 60000 }, () => {
    const g = finishedGame();
    expect(led(g).phase).toBe(Phase.FINISHED);
    expect(() => runAt(g, g.p1, T0, 'startTimeout', BigInt(T0 + GRACE + 60)))
      .toThrow(/not in play/);
    expect(() => runAt(g, g.p1, T0 + MAXW, 'claimTimeout')).toThrow(/not in play/);
  });

  it('a normal game still plays to a clean claimWin with the clock available', { timeout: 60000 }, () => {
    const g = startedGame();
    const p2Fleet = [[3, 0], [4, 0], [5, 0], [3, 1], [4, 1], [3, 2], [4, 2]];
    let i = 0;
    for (const [x, y] of p2Fleet) {
      run(g, g.p1, 'fire', BigInt(x), BigInt(y));
      run(g, g.p2, 'report');
      run(g, g.p2, 'fire', BigInt(i), 4n);
      run(g, g.p1, 'report');
      i += 1;
    }
    const mid = led(g);
    expect(mid.hits2).toBe(7n);
    expect(mid.timeoutDeadline.is_some).toBe(false);
    run(g, g.p1, 'claimWin');
    const l = led(g);
    expect(l.phase).toBe(Phase.FINISHED);
    expect(Buffer.from(l.winner.value).toString('hex'))
      .toBe(Buffer.from(l.p1).toString('hex'));
  });
});
