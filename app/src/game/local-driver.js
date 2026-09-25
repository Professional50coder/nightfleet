// BrowserLocalDriver - the driver that runs today, in the browser.
//
// It is a faithful model of contract/src/nightfleet.compact's state machine
// (same phases, same turn order, same win condition, same shot log shape) using
// the same `shared/` rules, but with NO zero-knowledge proofs and no ledger.
// It exists so the game is playable and the UI is real while the proof-server
// transport is built behind the same interface (see driver.js).
//
// What is honest about it:
//   - it enforces every *rule* the contract enforces, client-side;
//   - it enforces the *fog*: the opponent's layout is a `#private` field and
//     leaves this object only through revealFleets(), which requires FINISHED;
//   - it does NOT prove anything. `describe().provesMoves` is false, and the UI
//     says so rather than claiming a proof it did not generate.
//
// The opponent seat is `ai/opponent.js` (frozen, deterministic, seeded) and the
// narration is `ai/narrator.js`'s template path - both are pure JS with no Node
// dependencies, so they bundle for the browser unchanged.
import { Opponent, opponentFleet } from '../../../ai/opponent.js';
import { createNarrator } from '../../../ai/narrator.js';
import {
  GRID_CELLS,
  FLEET_CELLS,
  coordinateToIndex,
  indexToCoordinate,
  formatCoordinate,
  isCoordinate,
  assertValidFleet,
} from './protocol.js';
import { DriverError, PHASE, MARK, SEAT, emptySeatView } from './driver.js';

const AI_NAME = 'nightfleet-ai';

/**
 * Display-only commitment digest.
 *
 * The real commitment is `persistentHash` inside commitBoard() in the Compact
 * contract; this is an FNV-1a fold used purely so the HUD can show a stable
 * hash-art tile for a committed fleet. It is NOT cryptographic and nothing in
 * this app depends on it being hiding or binding.
 */
export function displayCommitment(board, salt) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const bytes = [...board, 0xff, ...salt];
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + b + 0x9e3779b9, 0x85ebca6b) >>> 0;
  }
  const word = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return `${word(h1)}${word(h2)}${word(Math.imul(h1 ^ h2, 0xc2b2ae35))}${word(h1 + h2)}`;
}

export class BrowserLocalDriver {
  // The privacy boundary is a language-level one: these are #private fields.
  // Nothing outside this class can read them - not the UI, not a test, not
  // JSON.stringify - which is how the fog rule in driver.js is enforced rather
  // than merely promised.
  #opponentFleet = null;
  #yourFleet = null;
  #yourSalt = null;
  #aiSalt = null;
  #engine = null;

  /** @param {{ seed?: number, difficulty?: 'easy'|'medium'|'hard', narrator?: object }} opts */
  constructor({ seed = 1, difficulty = 'medium', narrator = createNarrator() } = {}) {
    this.seed = seed;
    this.difficulty = difficulty;
    this.narrator = narrator;
    this.listeners = new Set();
    this.#reset();
  }

  async describe() {
    return {
      id: 'browser-local',
      name: 'Local (in-browser)',
      provesMoves: false,
      onChain: false,
      available: true,
      summary:
        'Rules run in your browser from the same shared/ module the contract uses. ' +
        'No proofs are generated and nothing is written to a ledger.',
    };
  }

  /** Start a fresh game. The AI takes its seat and commits immediately. */
  async newGame({ seed = this.seed, difficulty = this.difficulty } = {}) {
    this.seed = seed;
    this.difficulty = difficulty;
    this.#reset();
    // Both seats join, then the AI commits (it is p2). You are p1 and fire first,
    // matching `phase = (phase == Phase.OPEN) ? PLACED_1 : PLAYING` in the contract.
    this.#opponentFleet = opponentFleet(seed ^ 0x5f3759df);
    assertValidFleet(this.#opponentFleet);
    this.#aiSalt = this.#deriveSalt(seed);
    this.aiCommitment = displayCommitment(this.#opponentFleet, this.#aiSalt);
    this.phase = PHASE.PLACED_2;
    this.#log('commitBoard', { seat: SEAT.OPPONENT });
    this.#say({ type: 'commit', player: AI_NAME });
    this.#emit();
    return this.getState();
  }

  /**
   * Commit your fleet. Validated with shared's `assertValidFleet` - the exact
   * rule commitBoard() asserts on-chain.
   * @param {Array<0|1>} board
   */
  async commitFleet(board) {
    if (this.phase === PHASE.PLAYING || this.phase === PHASE.FINISHED) {
      throw new DriverError('your fleet is already committed');
    }
    try {
      assertValidFleet(board);
    } catch (err) {
      throw new DriverError(err.message);
    }
    this.#yourFleet = [...board];
    this.#yourSalt = this.#deriveSalt(this.seed ^ 0xa5a5a5);
    this.yourCommitment = displayCommitment(this.#yourFleet, this.#yourSalt);
    this.phase = PHASE.PLAYING;
    this.turn = SEAT.YOU; // p1 fires first
    this.#log('commitBoard', { seat: SEAT.YOU });
    this.#say({ type: 'commit', player: 'you' });
    this.#emit();
    return { commitment: this.yourCommitment, state: await this.getState() };
  }

  /**
   * Fire one shot, then let the AI answer and take its own turn - one call is
   * one full round, which is how the contract's fire/report pairs sequence.
   * @param {{x:number,y:number}} coord
   * @returns {Promise<{ yours: object, theirs: object|null, state: object }>}
   */
  async fire(coord) {
    if (this.phase !== PHASE.PLAYING) {
      throw new DriverError(
        this.phase === PHASE.FINISHED ? 'this game is over' : 'commit your fleet first');
    }
    if (this.turn !== SEAT.YOU) throw new DriverError('not your turn');
    if (!isCoordinate(coord)) throw new DriverError('that cell is off the board');
    const idx = coordinateToIndex(coord);
    if (this.opponentMarks[idx] !== MARK.UNKNOWN) {
      throw new DriverError(`you already fired at ${formatCoordinate(coord)}`);
    }

    // fire() then the defender's report(): the only thing that leaves the
    // opponent's hidden board is this one cell's hit/miss.
    this.#log('fire', { seat: SEAT.YOU, coord });
    this.#say({ type: 'fire', player: 'you', coord });
    const result = this.#opponentFleet[idx] === 1 ? 'hit' : 'miss';
    this.opponentMarks[idx] = result === 'hit' ? MARK.HIT : MARK.MISS;
    if (result === 'hit') this.opponentHitsTaken += 1;
    this.#log('report', { seat: SEAT.OPPONENT, coord, result });
    this.#say({ type: 'report', coord, result });
    const yours = { seat: SEAT.YOU, coord, result };
    this.lastShot = yours;

    if (this.opponentHitsTaken >= FLEET_CELLS) {
      this.#finish(SEAT.YOU);
      this.#emit();
      return { yours, theirs: null, state: await this.getState() };
    }

    this.turn = SEAT.OPPONENT;
    const theirs = this.#opponentTurn();
    this.#emit();
    return { yours, theirs, state: await this.getState() };
  }

  /** @returns {Promise<import('./driver.js').PublicState>} public state only */
  async getState() {
    return this.getStateSync();
  }

  /**
   * Synchronous view, for React render paths. Returns a fresh object each call;
   * `opponent.fleet` is null by construction until revealFleets() runs.
   */
  getStateSync() {
    return {
      phase: this.phase,
      turn: this.turn,
      winner: this.winner,
      fleetCells: FLEET_CELLS,
      difficulty: this.difficulty,
      seed: this.seed,
      yourCommitment: this.yourCommitment,
      opponentCommitment: this.aiCommitment,
      you: {
        fleet: this.#yourFleet ? [...this.#yourFleet] : null,
        marks: [...this.yourMarks],
        hitsTaken: this.yourHitsTaken,
      },
      opponent: {
        // Never `this.#opponentFleet`. The fog is this null.
        fleet: this.revealedFleets ? [...this.revealedFleets.opponent] : null,
        marks: [...this.opponentMarks],
        hitsTaken: this.opponentHitsTaken,
      },
      lastShot: this.lastShot ? { ...this.lastShot } : null,
      revealed: this.revealedFleets !== null,
    };
  }

  async getShotLog() { return this.log.map((e) => ({ ...e })); }

  /** Narration lines produced so far (template path; never sees board data). */
  async getNarration() { return [...this.narration]; }

  /**
   * Post-game audit, the analogue of revealBoard(). This is the ONLY exit for
   * the opponent's layout and it is gated on FINISHED - opening it earlier
   * would break the game, not just the UI.
   */
  async revealFleets() {
    if (this.phase !== PHASE.FINISHED) throw new DriverError('game not finished');
    this.revealedFleets = {
      you: this.#yourFleet ? [...this.#yourFleet] : null,
      opponent: [...this.#opponentFleet],
    };
    this.#log('revealBoard', { seat: SEAT.OPPONENT });
    this.#emit();
    return {
      you: this.revealedFleets.you,
      opponent: this.revealedFleets.opponent,
      commitmentsMatch:
        displayCommitment(this.revealedFleets.opponent, this.#aiSalt) === this.aiCommitment,
    };
  }

  /** @param {(state: object) => void} listener @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- internals -----------------------------------------------------------

  #reset() {
    this.phase = PHASE.OPEN;
    this.turn = null;
    this.winner = null;
    this.lastShot = null;
    this.log = [];
    this.narration = [];
    this.revealedFleets = null;
    this.yourCommitment = null;
    this.aiCommitment = null;
    this.yourMarks = Array(GRID_CELLS).fill(MARK.UNKNOWN);
    this.opponentMarks = Array(GRID_CELLS).fill(MARK.UNKNOWN);
    this.yourHitsTaken = 0;
    this.opponentHitsTaken = 0;
    this.#yourFleet = null;
    this.#opponentFleet = null;
    this.#engine = new Opponent({ difficulty: this.difficulty, seed: this.seed });
  }

  #deriveSalt(seed) {
    // Deterministic per-game filler so the display commitment is stable across
    // a reload of the same seed. Not a security salt - see displayCommitment().
    return Array.from({ length: 32 }, (_, i) => (Math.imul(seed + i, 0x9e3779b9) >>> 24) & 0xff);
  }

  #opponentTurn() {
    const coord = this.#engine.nextShot();
    const idx = coordinateToIndex(coord);
    this.#log('fire', { seat: SEAT.OPPONENT, coord });
    this.#say({ type: 'fire', player: AI_NAME, coord });
    const result = this.#yourFleet[idx] === 1 ? 'hit' : 'miss';
    this.yourMarks[idx] = result === 'hit' ? MARK.HIT : MARK.MISS;
    if (result === 'hit') this.yourHitsTaken += 1;
    this.#engine.recordShot(coord, result);
    this.#log('report', { seat: SEAT.YOU, coord, result });
    this.#say({ type: 'report', coord, result });
    const shot = { seat: SEAT.OPPONENT, coord, result };
    this.lastShot = shot;
    if (this.yourHitsTaken >= FLEET_CELLS) this.#finish(SEAT.OPPONENT);
    else this.turn = SEAT.YOU;
    return shot;
  }

  #finish(winner) {
    this.winner = winner;
    this.phase = PHASE.FINISHED;
    this.turn = null;
    this.#log('claimWin', { seat: winner });
    this.#say({ type: 'win', player: winner === SEAT.YOU ? 'you' : AI_NAME });
  }

  #log(circuit, fields) {
    this.log.push({ seq: this.log.length, circuit, ...fields });
  }

  /**
   * Narrate a public event. Only the narrator's whitelisted public fields are
   * passed: type, player, coord, result. A board, a salt or a mark array would
   * be rejected by the narrator, and is never assembled here in the first place.
   */
  #say(event) {
    try {
      this.narration.push({ seq: this.narration.length, line: this.narrator.narrate(event) });
    } catch {
      // A narrator refusal must never take the game down.
    }
  }

  #emit() {
    const state = this.getStateSync();
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* a bad subscriber cannot break the game */ }
    }
  }
}

export { indexToCoordinate };
