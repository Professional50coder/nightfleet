// @nightfleet/cli engine: headless two-player game driver (human + scripted
// opponent) over @nightfleet/api's LocalGame. UI-agnostic so it is fully
// testable; play.js wires it to a terminal.
import { LocalGame } from '../api/local-game.js';
import { createNarrator } from '../ai/narrator.js';
import {
  GRID_SIZE, GRID_CELLS, FLEET_CELLS,
  coordinateToIndex, indexToCoordinate, parseCoordinate, formatCoordinate,
  randomFleet,
} from '../shared/index.js';

export class CliGame {
  /** @param {{humanName?: string, rng?: () => number, narrator?: object}} opts */
  constructor({ humanName = 'you', rng = Math.random, narrator = createNarrator() } = {}) {
    this.rng = rng;
    this.narrator = narrator;         // referee voice; template-based by default
    this.narrationLog = [];           // lines since last drainNarration()
    this.game = LocalGame.create();
    this.human = this.game.addPlayer(humanName);
    this.bot = this.game.addPlayer('nightfleet-ai');
    this.botBoard = randomFleet(rng);
    this.humanBoard = null;
    this.game.commitBoard(this.bot, this.botBoard);
    this.#say({ type: 'commit', player: this.bot.name });
    this.myShots = new Set();  // idx fired by human
    this.botShots = new Set(); // idx fired by bot
  }

  #say(event) { this.narrationLog.push(this.narrator.narrate(event)); }

  /** Narration lines produced since the last call (drained). @returns {string[]} */
  drainNarration() { return this.narrationLog.splice(0); }


  /** Place the human fleet randomly. @returns {Array<0|1>} the board */
  placeRandom() {
    this.humanBoard = randomFleet(this.rng);
    this.game.commitBoard(this.human, this.humanBoard);
    this.#say({ type: 'commit', player: this.human.name });
    return this.humanBoard;
  }

  /** Place the human fleet from coordinates, e.g. ['A1','B1','C1','A2','B2','A3','B3']. */
  placeAt(cells) {
    const board = Array(GRID_CELLS).fill(0);
    for (const text of cells) board[coordinateToIndex(parseCoordinate(text))] = 1;
    this.humanBoard = board;
    this.game.commitBoard(this.human, board);
    this.#say({ type: 'commit', player: this.human.name });
    return board;
  }

  /** Human fires. @returns {{result:'hit'|'miss', sunk:boolean, gameOver:boolean, winner:string|null}} */
  fire(text) {
    this.#needBoard();
    const coord = parseCoordinate(text);
    const idx = coordinateToIndex(coord);
    if (this.myShots.has(idx)) throw new Error(`already fired at ${formatCoordinate(coord)}`);
    this.myShots.add(idx);
    this.game.fire(this.human, coord);
    const result = this.game.report(this.bot);
    this.#say({ type: 'fire', player: this.human.name, coord });
    this.#say({ type: 'report', coord, result });
    const gameOver = this.myShots.size >= 0 && this.game.state().hitsLanded[this.human.name] === FLEET_CELLS;
    let winner = null;
    if (gameOver) { winner = this.game.claimWin(this.human); this.#say({ type: 'win', player: winner }); }
    return { result, sunk: result === 'hit' && gameOver, gameOver, winner };
  }

  /** Scripted opponent turn: hunts an untried cell. @returns {{coord:string, result:string, gameOver:boolean, winner:string|null}} */
  botTurn() {
    this.#needBoard();
    let idx = -1;
    for (let attempt = 0; attempt < 1000 && idx === -1; attempt += 1) {
      const cand = Math.floor(this.rng() * GRID_CELLS);
      if (!this.botShots.has(cand)) idx = cand;
    }
    if (idx === -1) idx = Array.from({ length: GRID_CELLS }, (_, i) => i).find((i) => !this.botShots.has(i));
    this.botShots.add(idx);
    const coord = indexToCoordinate(idx);
    this.game.fire(this.bot, coord);
    const result = this.game.report(this.human);
    this.#say({ type: 'fire', player: this.bot.name, coord });
    this.#say({ type: 'report', coord, result });
    const gameOver = this.game.state().hitsLanded[this.bot.name] === FLEET_CELLS;
    let winner = null;
    if (gameOver) { winner = this.game.claimWin(this.bot); this.#say({ type: 'win', player: winner }); }
    return { coord: formatCoordinate(coord), result, gameOver, winner };
  }

  /** ASCII boards: fleet (own board + bot shots) and targets (own shots). */
  renderBoards() {
    const hitIdx = new Set(), missIdx = new Set();
    // reconstruct from log: fire entries by player in order, reports follow
    const log = this.game.shotLog();
    for (let i = 0; i < log.length; i += 1) {
      const e = log[i];
      if (e.circuit !== 'fire') continue;
      const rep = log[i + 1];
      const idx = coordinateToIndex({ x: e.x, y: e.y });
      if (e.player === this.human.name) (rep?.result === 'hit' ? hitIdx : missIdx).add(idx);
    }
    const rows = ['   A B C D E F G H      A B C D E F G H'];
    for (let y = 0; y < GRID_SIZE; y += 1) {
      let own = `${y + 1}  `, tgt = `${y + 1}  `;
      for (let x = 0; x < GRID_SIZE; x += 1) {
        const idx = coordinateToIndex({ x, y });
        own += (this.botShots.has(idx) ? (this.humanBoard?.[idx] ? 'X' : 'o') : (this.humanBoard?.[idx] ? '#' : '.')) + ' ';
        tgt += (hitIdx.has(idx) ? 'X' : missIdx.has(idx) ? 'o' : '.') + ' ';
      }
      rows.push(`${own}   ${tgt}`);
    }
    return `  YOUR FLEET          YOUR SHOTS\n${rows.join('\n')}`;
  }

  /** Post-game audit: both players prove their boards match the commitments. */
  reveal() {
    if (this.game.state().phase !== 'FINISHED') throw new Error('game not finished');
    this.game.revealBoard(this.human);
    this.game.revealBoard(this.bot);
    return this.game.state().revealed;
  }

  #needBoard() {
    if (!this.humanBoard) throw new Error('place your fleet first: place auto | place A1 B1 ...');
  }
}
