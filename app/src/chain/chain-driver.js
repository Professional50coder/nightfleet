// ChainDriver - the proof-backed driver behind squad links.
//
// One NightFleet deployment is one game. The host's browser deploys a fresh
// contract, the squad link carries its address, and the joiner's browser
// binds to the same deployment. Every move is a circuit call settled on
// Midnight Preprod; this driver reads the public ledger back through the
// indexer and projects it through the same fog rule as the local driver:
// the opponent seat shows marks for cells you fired at, and nothing more.
//
// Secrets never leave the browser: the fleet, salt and secret key live in
// the BrowserPrivateStateProvider and feed the circuits as witnesses.
//
// HOW MARKS ARE LEARNED (the ledger does not publish per-cell results):
// a shot sits in `pendingShot` until the defender's report() clears it, and
// the hits counters move by one on a hit. Watching that transition answers
// exactly one cell: pending cleared + counter moved => HIT, else MISS.
// Results for transitions this browser never observed stay UNKNOWN rather
// than being guessed - the fog rule is never traded for a prettier board.

import { PHASE, MARK } from '../game/protocol.js';
import { DriverError } from '../game/driver.js';
import { ledger } from '../vendor/nightfleet-contract/index.js';
import { PRIVATE_STATE_ID } from './nightfleet-chain.js';
import * as chain from './nightfleet-chain.js';
import { connectWallet } from './lace.js';
import { createBrowserProviders } from './providers.js';
import { BrowserPrivateStateProvider } from './private-state.js';
import { freshPrivateState } from './nightfleet-chain.js';

const PHASE_NAMES = ['OPEN', 'PLACED_1', 'PLACED_2', 'PLAYING', 'FINISHED'];
const toHex32 = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const cellIndex = (c) => c.y * 8 + c.x;

/** The ledger snapshot, normalized to plain values the projection can read. */
export function readLedger(contractState) {
  const l = ledger(contractState.data ?? contractState);
  return {
    phase: PHASE_NAMES[Number(l.phase)] ?? 'OPEN',
    p1: toHex32(l.p1),
    p2: toHex32(l.p2),
    turn: l.turn ? toHex32(l.turn) : null,
    pendingShot: l.pendingShot?.is_some ? { x: Number(l.pendingShot.value.x), y: Number(l.pendingShot.value.y) } : null,
    hits1: Number(l.hits1),
    hits2: Number(l.hits2),
    shots1: [...l.shots1].map(([cell]) => Number(cell)),
    shots2: [...l.shots2].map(([cell]) => Number(cell)),
    winner: l.winner?.is_some ? toHex32(l.winner.value) : null,
  };
}

export class ChainDriver {
  /**
   * @param {object} deps
   * @param {object} deps.providers midnight-js providers (browser assembly)
   * @param {string} deps.contractAddress the deployment this driver plays
   * @param {() => Promise<object>} [deps.queryContractState] indexer read seam for tests
   */
  constructor({ providers, contractAddress, queryContractState, connect = connectWallet, pollMs = 12000 } = {}) {
    this.providers = providers ?? null;
    this.contractAddress = contractAddress ?? null;
    this.connect = connect;
    this.pollMs = pollMs;
    this.poller = null;
    // Tests inject queryContractState; production reads the indexer.
    this.#queryOverride = queryContractState ?? null;
    if (this.providers && this.contractAddress && !this.#queryOverride) {
      this.queryContractState = () => this.providers.publicDataProvider.queryContractState(this.contractAddress);
    } else {
      this.queryContractState = this.#queryOverride;
    }
    this.listeners = new Set();
    this.info = {
      id: 'midnight-preprod',
      name: 'Midnight Preprod (proof-backed)',
      provesMoves: true,
      onChain: true,
      summary: 'Every report answered by a zero-knowledge proof against your committed board, settled on Midnight Preprod.',
    };
  }

  async describe() { return { ...this.info, available: true }; }

  #emit() { this.listeners.forEach((fn) => fn()); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  #queryOverride = null;

  /** Connect the wallet and build providers on first use. */
  async #ensure() {
    if (!this.providers) {
      const { api } = await this.connect({ networkId: 'preprod' });
      const privateStateProvider = new BrowserPrivateStateProvider();
      this.providers = await createBrowserProviders(
        api, privateStateProvider, globalThis.location?.origin ?? 'http://localhost',
      );
    }
    if (!this.contractAddress) throw new DriverError('no game bound yet - create or join a squad first');
    this.providers.privateStateProvider.setContractAddress(this.contractAddress);
    if (!this.#queryOverride) {
      this.queryContractState = () => this.providers.publicDataProvider.queryContractState(this.contractAddress);
    }
    if (!this.poller) {
      this.poller = setInterval(() => {
        this.getState().then(() => this.#emit()).catch(() => {});
      }, this.pollMs);
      if (typeof this.poller.unref === 'function') this.poller.unref();
    }
  }

  /** A seat must exist before we can hold secrets for it. */
  async #ensureSeatState() {
    const psp = this.providers.privateStateProvider;
    if (!(await psp.get(PRIVATE_STATE_ID))) await psp.set(PRIVATE_STATE_ID, freshPrivateState());
  }

  async #state() {
    const psp = this.providers.privateStateProvider;
    const state = await psp.get(PRIVATE_STATE_ID);
    if (!state) throw new DriverError('no local seat secrets for this game - rejoin from your squad link on this browser');
    state.marks ??= { mine: Array(64).fill(MARK.UNKNOWN), theirs: Array(64).fill(MARK.UNKNOWN) };
    state.lastSeen ??= null;
    return state;
  }

  #save(state) { return this.providers.privateStateProvider.set(PRIVATE_STATE_ID, state); }

  /**
   * Create or join a squad game.
   * No `contractAddress`: deploy a fresh contract (host path) and seat p1.
   * With `contractAddress` (from a squad link): bind to that deployment and seat p2.
   */
  async newGame({ contractAddress } = {}) {
    if (contractAddress) this.contractAddress = contractAddress;
    await this.#ensure();
    if (!contractAddress) {
      this.contractAddress = await chain.deployNightfleet(this.providers);
      this.providers.privateStateProvider.setContractAddress(this.contractAddress);
    }
    await this.#ensureSeatState();
    const before = readLedger(await this.queryContractState());
    const seated = (hex) => hex && /^[0-9a-f]{64}$/.test(hex) && !/^0+$/.test(hex);
    if (seated(before.p1) && seated(before.p2)) {
      throw new DriverError('that squad is full - two players are already seated');
    }
    const state = await this.#state();
    await chain.joinGame(this.providers, this.contractAddress);
    state.seat = seated(before.p1) ? 'p2' : 'p1';
    await this.#save(state);
    this.#emit();
    return this.getState();
  }

  /** Commit the fleet: secrets in, hash out. The board never leaves the browser. */
  async commitFleet(board) {
    await this.#ensure();
    const state = await this.#state();
    state.board = board.map((c) => BigInt(c));
    if (!state.salt?.some((b) => b !== 0)) state.salt = crypto.getRandomValues(new Uint8Array(32));
    if (!state.sk?.some((b) => b !== 0)) state.sk = crypto.getRandomValues(new Uint8Array(32));
    await this.#save(state);
    await chain.commitBoard(this.providers, this.contractAddress);
    this.#emit();
    return { commitment: null, state: await this.getState() };
  }

  async fire(coord) {
    await this.#ensure();
    await chain.fire(this.providers, this.contractAddress, coord.x, coord.y);
    this.#emit();
    return this.getState();
  }

  /** Answer the shot pending against our fleet (the defender's move). */
  async report() {
    await this.#ensure();
    await chain.report(this.providers, this.contractAddress);
    this.#emit();
    return this.getState();
  }

  async getState() {
    const l = readLedger(await this.queryContractState());
    const state = await this.#state();
    const mine = state.seat !== 'p2'; // hosts seat p1; default until seated
    const myPk = mine ? l.p1 : l.p2;

    // --- observe transitions and fold results into the persisted marks ---
    const myShots = new Set(mine ? l.shots1 : l.shots2);
    const landed = mine ? l.hits2 : l.hits1; // hits I have landed on the opponent
    const taken = mine ? l.hits1 : l.hits2;  // hits the opponent has landed on me
    const prev = state.lastSeen;
    if (prev?.pendingShot) {
      const cell = cellIndex(prev.pendingShot);
      const answered = !l.pendingShot || cellIndex(l.pendingShot) !== cell;
      if (answered && state.marks) {
        if (prev.pendingWasMine) {
          state.marks.theirs[cell] = landed > prev.landed ? MARK.HIT : MARK.MISS;
        } else {
          state.marks.mine[cell] = taken > prev.taken ? MARK.HIT : MARK.MISS;
        }
      }
    }
    state.lastSeen = l.pendingShot
      ? { pendingShot: l.pendingShot, pendingWasMine: myShots.has(cellIndex(l.pendingShot)), landed, taken }
      : null;
    await this.#save(state);

    // Fired-at cells with no observed result stay UNKNOWN; observed ones use
    // the persisted marks. The opponent's fleet itself never appears.
    const oppMarks = Array(64).fill(MARK.UNKNOWN);
    for (const cell of myShots) oppMarks[cell] = state.marks.theirs[cell];
    const myMarks = Array(64).fill(MARK.UNKNOWN);
    for (const cell of (mine ? l.shots2 : l.shots1)) myMarks[cell] = state.marks.mine[cell];

    return {
      phase: l.phase,
      turn: l.phase !== 'PLAYING' ? null : (l.turn === myPk ? 'you' : 'opponent'),
      winner: !l.winner ? null : (l.winner === myPk ? 'you' : 'opponent'),
      fleetCells: 7,
      you: {
        fleet: state.board?.some((c) => c !== 0n) ? state.board.map(Number) : null,
        marks: myMarks,
        hitsTaken: taken,
      },
      opponent: { fleet: null, marks: oppMarks, hitsTaken: landed },
      lastShot: null,
      revealed: false,
      contractAddress: this.contractAddress,
      pendingShot: l.pendingShot,
    };
  }

  async getShotLog() { return []; }
  async getNarration() { return []; }

  async revealFleets() {
    await this.#ensure();
    await chain.revealBoard(this.providers, this.contractAddress);
    const state = await this.#state();
    return { yours: state.board.map(Number), theirs: null, state: await this.getState() };
  }
}
