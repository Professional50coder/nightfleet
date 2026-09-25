// ChainDriver projection, tested against the REAL compiled contract running
// in-process (same pattern as cli/test/engine.test.js): genuine ledger states
// in, fog-respecting public state out.
import { describe, expect, it } from 'vitest';
import { Contract } from '../src/vendor/nightfleet-contract/index.js';
import { createConstructorContext, createCircuitContext } from '@midnight-ntwrk/compact-runtime';
import { sampleContractAddress } from '@midnight-ntwrk/onchain-runtime-v3';
import { ChainDriver } from '../src/chain/chain-driver.js';
import { BrowserPrivateStateProvider } from '../src/chain/private-state.js';
import { MARK } from '../src/game/protocol.js';

const ADDRESS = sampleContractAddress();
const COIN_PK = '0'.repeat(64);

const witnesses = {
  localSecretKey: (ctx) => [ctx.privateState, ctx.privateState.sk],
  myBoard: (ctx) => [ctx.privateState, ctx.privateState.board],
  mySalt: (ctx) => [ctx.privateState, ctx.privateState.salt],
};

const fleetAt = (cells) => {
  const board = Array(64).fill(0n);
  cells.forEach((c) => { board[c] = 1n; });
  return board;
};

function makeWorld() {
  const contract = new Contract(witnesses);
  let cur = contract.initialState(
    createConstructorContext({ sk: new Uint8Array(32), salt: new Uint8Array(32), board: Array(64).fill(0n) }, COIN_PK),
  ).currentContractState;
  const call = (circuit, priv, ...args) => {
    const res = contract.impureCircuits[circuit](createCircuitContext(ADDRESS, COIN_PK, cur, priv), ...args);
    cur = res.context.currentQueryContext.state;
  };
  const p1 = { sk: new Uint8Array(32).fill(1), salt: new Uint8Array(32).fill(11), board: fleetAt([10, 11, 12, 13, 14, 15, 16]) };
  const p2 = { sk: new Uint8Array(32).fill(2), salt: new Uint8Array(32).fill(22), board: fleetAt([0, 21, 22, 23, 24, 25, 26]) };
  return { call: (c, who, ...a) => call(c, who === 'p1' ? p1 : p2, ...a), state: () => cur, p1, p2 };
}

function makeDriver(world, seat, board) {
  const storage = new Map();
  const shim = {
    get length() { return storage.size; },
    key: (i) => [...storage.keys()][i] ?? null,
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const privateStateProvider = new BrowserPrivateStateProvider(shim);
  privateStateProvider.setContractAddress('a'.repeat(64));
  privateStateProvider.set('nightfleet', {
    sk: new Uint8Array(32).fill(seat === 'p1' ? 1 : 2),
    salt: new Uint8Array(32).fill(9),
    board,
    seat,
  });
  return new ChainDriver({
    providers: { privateStateProvider },
    contractAddress: 'a'.repeat(64),
    queryContractState: async () => world.state(),
  });
}

describe('ChainDriver projection (real compiled contract, in-process)', () => {
  it('projects a playing game with the fog rule intact and learns a hit from the report transition', async () => {
    const world = makeWorld();
    world.call('joinGame', 'p1');
    world.call('joinGame', 'p2');
    world.call('commitBoard', 'p1');
    world.call('commitBoard', 'p2');

    const driver = makeDriver(world, 'p1', world.p1.board);
    const open = await driver.getState();
    expect(open.phase).toBe('PLAYING');
    expect(open.turn).toBe('you');            // p1 fires first
    expect(open.opponent.fleet).toBeNull();   // the fog rule
    expect(open.you.fleet?.map(Number).filter(Boolean)).toHaveLength(7);

    world.call('fire', 'p1', 0n, 0n);           // p2 has a ship at cell 0
    const pending = await driver.getState();  // observes the pending shot
    expect(pending.pendingShot).toEqual({ x: 0, y: 0 });
    expect(pending.opponent.marks[0]).toBe(MARK.UNKNOWN); // not answered yet

    world.call('report', 'p2');               // p2 answers: hit (ship at 0)
    const after = await driver.getState();    // observes the resolution
    expect(after.opponent.marks[0]).toBe(MARK.HIT);
    expect(after.opponent.hitsTaken).toBe(1);
    expect(after.turn).toBe('opponent');
    expect(after.winner).toBeNull();
  });

  it('marks a miss when the counter does not move', async () => {
    const world = makeWorld();
    world.call('joinGame', 'p1');
    world.call('joinGame', 'p2');
    world.call('commitBoard', 'p1');
    world.call('commitBoard', 'p2');
    const driver = makeDriver(world, 'p1', world.p1.board);

    world.call('fire', 'p1', 7n, 7n);           // p2 has no ship at cell 63
    await driver.getState();
    world.call('report', 'p2');
    const after = await driver.getState();
    expect(after.opponent.marks[63]).toBe(MARK.MISS);
    expect(after.opponent.hitsTaken).toBe(0);
  });
});
