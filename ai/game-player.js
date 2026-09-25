// @nightfleet/ai - GamePlayer: an AI seat at a real LocalGame (docs/06 §2).
// The AI holds its own board + salt, commits like a human, and fires/reports
// through the same api/ path - no fake mode.
import { randomFleet } from '../shared/index.js';
import { Opponent, mulberry32 } from './opponent.js';

export class GamePlayer {
  /**
   * Join a LocalGame as `name`. Both seats must join before anyone commits
   * (contract phase rule), so committing is a separate step: commitSeat().
   * @param {import('../api/local-game.js').LocalGame} game
   * @param {string} name
   * @param {{ difficulty?: 'easy'|'medium'|'hard', seed?: number }} opts
   */
  constructor(game, name, { difficulty = 'medium', seed = 1 } = {}) {
    this.game = game;
    this.name = name;
    this.engine = new Opponent({ difficulty, seed });
    this.handle = game.addPlayer(name);
    this.board = randomFleet(mulberry32(seed ^ 0x9e3779b9));
    this.commitment = null;
  }

  /** Commit this seat's seeded fleet. @returns {string} commitment hex */
  commitSeat() {
    this.commitment = this.game.commitBoard(this.handle, this.board);
    return this.commitment;
  }

  /**
   * Fire one engine-chosen shot at `defenderHandle` and learn the result.
   * Caller checks state().winner / claimWin. @returns {{x:number,y:number,result:'hit'|'miss'}}
   */
  takeTurn(defenderHandle) {
    const coord = this.engine.nextShot();
    this.game.fire(this.handle, coord);
    const result = this.game.report(defenderHandle);
    this.engine.recordShot(coord, result);
    return { ...coord, result };
  }
}
