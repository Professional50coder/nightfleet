// Engine test: a scripted game completes with a winner and valid transcript.
import { describe, it, expect } from 'vitest';
import { CliGame } from '../engine.js';
import { indexToCoordinate, formatCoordinate, FLEET_CELLS } from '../../shared/index.js';

describe('CliGame', () => {
  it('human can sink the bot fleet and claim the win', () => {
    const cli = new CliGame({ rng: () => 0.42 });
    cli.placeAt(['A1', 'B1', 'C1', 'A2', 'B2', 'A3', 'B3']);
    // fire exactly at the bot's fleet cells (test knows the board)
    const cells = cli.botBoard.map((c, i) => (c === 1 ? i : -1)).filter((i) => i >= 0);
    expect(cells).toHaveLength(FLEET_CELLS);
    let final;
    for (const idx of cells) {
      final = cli.fire(formatCoordinate(indexToCoordinate(idx)));
      if (!final.gameOver) cli.botTurn();
    }
    expect(final.gameOver).toBe(true);
    expect(final.winner).toBe('you');
    expect(cli.game.state().phase).toBe('FINISHED');
  });

  it('rejects firing at the same cell twice', () => {
    const cli = new CliGame();
    cli.placeAt(['A1', 'B1', 'C1', 'A2', 'B2', 'A3', 'B3']);
    cli.fire('H8');
    cli.botTurn();
    expect(() => cli.fire('H8')).toThrow('already fired');
  });

  it('requires placing a fleet before firing', () => {
    const cli = new CliGame();
    expect(() => cli.fire('A1')).toThrow('place your fleet first');
  });

  it('renders boards without crashing', () => {
    const cli = new CliGame();
    cli.placeRandom();
    cli.fire('C3');
    cli.botTurn();
    expect(cli.renderBoards()).toContain('YOUR FLEET');
  });

  it('reveals both boards only after the game ends', () => {
    const cli = new CliGame({ rng: () => 0.42 });
    cli.placeAt(['A1', 'B1', 'C1', 'A2', 'B2', 'A3', 'B3']);
    expect(() => cli.reveal()).toThrow('game not finished');
    const cells = cli.botBoard.map((c, i) => (c === 1 ? i : -1)).filter((i) => i >= 0);
    let final;
    for (const idx of cells) {
      final = cli.fire(formatCoordinate(indexToCoordinate(idx)));
      if (!final.gameOver) cli.botTurn();
    }
    expect(final.gameOver).toBe(true);
    const revealed = cli.reveal();
    expect(revealed.you).toBe(true);
    expect(revealed['nightfleet-ai']).toBe(true);
  });

  it('narrates each move: what was proven, what stays hidden', () => {
    const cli = new CliGame({ rng: () => 0.42 });
    cli.placeAt(['A1', 'B1', 'C1', 'A2', 'B2', 'A3', 'B3']);
    const commits = cli.drainNarration();
    expect(commits).toHaveLength(2);
    expect(commits.join(' ')).toMatch(/locked in their fleet/);

    const cells = cli.botBoard.map((c, i) => (c === 1 ? i : -1)).filter((i) => i >= 0);
    const r = cli.fire(formatCoordinate(indexToCoordinate(cells[0])));
    expect(r.result).toBe('hit');
    const lines = cli.drainNarration();
    expect(lines).toHaveLength(2); // fire + report
    expect(lines[1]).toContain('HIT');
    expect(lines[1]).toMatch(/proof/i);
    expect(lines[1]).toMatch(/hidden/i);
    expect(cli.drainNarration()).toHaveLength(0); // drained

    const b = cli.botTurn();
    const botLines = cli.drainNarration();
    expect(botLines).toHaveLength(2);
    expect(botLines[0]).toContain(b.coord);

    // finish the game -> win line in the winning shot's narration
    let final; let lastLines = [];
    for (const idx of cells.slice(1)) {
      final = cli.fire(formatCoordinate(indexToCoordinate(idx)));
      lastLines = cli.drainNarration();
      if (!final.gameOver) { cli.botTurn(); cli.drainNarration(); }
    }
    expect(final.gameOver).toBe(true);
    expect(lastLines.join(' ')).toMatch(/wins\./);
  });
});
