// @nightfleet/api - LocalGame: drive the compiled NightFleet contract in-process.
// This is the local-stack api (Phase 1): typed wrappers over the five circuits,
// clean errors, and a replayable action log. On-chain transport (node + proof
// server + Lace fallback) plugs in behind the same interface at M1.
import { Contract, ledger, Phase } from '../contract/managed/contract/index.js';
import { createConstructorContext, createCircuitContext } from '@midnight-ntwrk/compact-runtime';
import { sampleContractAddress } from '@midnight-ntwrk/onchain-runtime-v3';
import { randomBytes } from 'node:crypto';
import { coordinateToIndex, assertValidFleet } from '../shared/index.js';

const ADDRESS = sampleContractAddress();
const COIN_PK = '0'.repeat(64);

const witnesses = {
  localSecretKey: (ctx) => [ctx.privateState, ctx.privateState.sk],
  myBoard: (ctx) => [ctx.privateState, ctx.privateState.board],
  mySalt: (ctx) => [ctx.privateState, ctx.privateState.salt],
};

const PHASE_NAMES = Object.keys(Phase).filter((k) => Number.isInteger(Phase[k]) || typeof Phase[k] === 'number');
const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** Error thrown for any contract-level rejection; message is the contract's assert text. */
export class GameError extends Error {}

/**
 * @typedef {{ id: number, name: string }} PlayerHandle
 * @typedef {{ phase: string, turn: string|null, pendingShot: {x:number,y:number}|null,
 *            hitsLanded: Record<string, number>, winner: string|null, revealed: Record<string, boolean> }} PublicState
 */
export class LocalGame {
  /** @returns {LocalGame} a fresh contract instance, OPEN phase */
  static create() {
    const contract = new Contract(witnesses);
    const bootstrap = { sk: new Uint8Array(32), salt: new Uint8Array(32), board: Array(64).fill(0n) };
    const { currentContractState } = contract.initialState(createConstructorContext(bootstrap, COIN_PK));
    const game = new LocalGame();
    game.contract = contract;
    game.contractState = currentContractState;
    game.players = []; // { handle, priv: {sk, salt, board} }
    game.log = [];     // replayable action transcript
    return game;
  }

  /** @param {string} name @returns {PlayerHandle} */
  addPlayer(name) {
    if (this.players.length >= 2) throw new GameError('game is full');
    const handle = { id: this.players.length, name };
    this.players.push({ handle, priv: { sk: randomBytes(32), salt: null, board: null } });
    this.#call(handle, 'joinGame');
    this.log.push({ circuit: 'joinGame', player: name });
    return handle;
  }

  /**
   * Commit a fleet. board is Array<0|1> of length 64; salt defaults to random.
   * @returns {string} commitment hex now on the ledger for this player
   */
  commitBoard(handle, board, salt = randomBytes(32)) {
    assertValidFleet(board);
    const entry = this.#entry(handle);
    entry.priv.board = board.map(BigInt);
    entry.priv.salt = salt;
    this.#call(handle, 'commitBoard');
    const commitment = this.#ledger()[handle.id === 0 ? 'commitment1' : 'commitment2'];
    this.log.push({ circuit: 'commitBoard', player: handle.name, board: [...board], salt: hex(salt) });
    return hex(commitment);
  }

  /** @param {{x:number,y:number}} coord */
  fire(handle, coord) {
    this.#call(handle, 'fire', BigInt(coord.x), BigInt(coord.y));
    this.log.push({ circuit: 'fire', player: handle.name, x: coord.x, y: coord.y });
  }

  /** Defender answers the pending shot. @returns {'hit'|'miss'} */
  report(handle) {
    const entry = this.#entry(handle);
    if (!entry.priv.board) throw new GameError('no board committed');
    const before = this.#ledger();
    this.#call(handle, 'report');
    const after = this.#ledger();
    const hitField = handle.id === 0 ? 'hits1' : 'hits2';
    const result = after[hitField] > before[hitField] ? 'hit' : 'miss';
    this.log.push({ circuit: 'report', player: handle.name, result });
    return result;
  }

  /** @returns {string} winner name */
  claimWin(handle) {
    this.#call(handle, 'claimWin');
    this.log.push({ circuit: 'claimWin', player: handle.name });
    return this.state().winner;
  }

  /** Post-game audit: prove the exposed board matches the commitment; marks it on-chain. */
  revealBoard(handle) {
    this.#call(handle, 'revealBoard');
    this.log.push({ circuit: 'revealBoard', player: handle.name });
    return this.state().revealed;
  }

  /** @returns {PublicState} */
  state() {
    const l = this.#ledger();
    const nameOf = (pkHex) => {
      if (!pkHex || pkHex === '0'.repeat(64)) return null;
      const idx = [hex(l.p1), hex(l.p2)].indexOf(pkHex);
      return idx === -1 ? null : this.players[idx].handle.name;
    };
    return {
      phase: PHASE_NAMES[l.phase] ?? String(l.phase),
      turn: nameOf(hex(l.turn)),
      pendingShot: l.pendingShot.is_some
        ? { x: Number(l.pendingShot.value.x), y: Number(l.pendingShot.value.y) }
        : null,
      revealed: {
        ...(this.players[0] ? { [this.players[0].handle.name]: l.revealed1 } : {}),
        ...(this.players[1] ? { [this.players[1].handle.name]: l.revealed2 } : {}),
      },
      hitsLanded: {
        ...(this.players[0] ? { [this.players[0].handle.name]: Number(l.hits2) } : {}),
        ...(this.players[1] ? { [this.players[1].handle.name]: Number(l.hits1) } : {}),
      },
      winner: l.winner.is_some ? nameOf(hex(l.winner.value)) : null,
    };
  }

  /** Replayable action transcript (client-side shot log; on-chain emission is a contract TODO). */
  shotLog() {
    return this.log.map((entry, seq) => ({ seq, ...entry }));
  }

  /** Re-run a transcript into a fresh game and return it (determinism check / audit). */
  static replay(entries) {
    const game = LocalGame.create();
    const byName = new Map();
    for (const entry of entries) {
      if (entry.circuit === 'joinGame') byName.set(entry.player, game.addPlayer(entry.player));
      else if (entry.circuit === 'commitBoard') {
        const salt = new Uint8Array(Buffer.from(entry.salt, 'hex'));
        game.commitBoard(byName.get(entry.player), entry.board, salt);
      } else if (entry.circuit === 'fire') game.fire(byName.get(entry.player), { x: entry.x, y: entry.y });
      else if (entry.circuit === 'report') game.report(byName.get(entry.player));
      else if (entry.circuit === 'claimWin') game.claimWin(byName.get(entry.player));
      else if (entry.circuit === 'revealBoard') game.revealBoard(byName.get(entry.player));
    }
    return game;
  }

  #entry(handle) {
    const entry = this.players[handle.id];
    if (!entry || entry.handle.name !== handle.name) throw new GameError('unknown player');
    return entry;
  }

  #ledger() {
    return ledger(this.contractState.data ?? this.contractState);
  }

  #call(handle, circuit, ...args) {
    const entry = this.#entry(handle);
    const ctx = createCircuitContext(ADDRESS, COIN_PK, this.contractState, entry.priv);
    try {
      const res = this.contract.impureCircuits[circuit](ctx, ...args);
      this.contractState = res.context.currentQueryContext.state;
      return res;
    } catch (err) {
      throw new GameError(err instanceof Error ? err.message : String(err));
    }
  }
}

export { coordinateToIndex };
