#!/usr/bin/env node
// NightFleet CLI: human vs scripted opponent on the local in-process stack.
// Usage: node play.js [--demo]
import * as readline from 'node:readline';
import { CliGame } from './engine.js';

const demo = process.argv.includes('--demo');
const cli = new CliGame({ rng: demo ? seedRng(42) : Math.random });
cli.placeRandom();

// referee-narrator lines (docs/06): what each move proved, what stayed hidden
const say = () => cli.drainNarration().forEach((l) => console.log(`  ${l}`));

console.log('NightFleet local game - your fleet is committed (ZK), the AI fleet is hidden.');
console.log('Type "fire B3", "boards", "log", "reveal" (after game over), "help", "quit".');

if (demo) {
  // Deterministic scripted run: fire through the whole grid row by row.
  let over = false;
  for (let n = 1; n <= 8 && !over; n += 1) {
    for (const col of 'ABCDEFGH') {
      const r = cli.fire(`${col}${n}`);
      console.log(`you fire ${col}${n}: ${r.result}`); say();
      if (r.gameOver) { console.log(`GAME OVER - winner: ${r.winner}`); over = true; break; }
      const b = cli.botTurn();
      console.log(`ai fires ${b.coord}: ${b.result}`); say();
      if (b.gameOver) { console.log(`GAME OVER - winner: ${b.winner}`); over = true; break; }
    }
  }
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.prompt();
rl.on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  try {
    if (cmd === 'fire' && rest[0]) {
      const r = cli.fire(rest[0]);
      console.log(r.result === 'hit' ? 'HIT!' : 'miss'); say();
      if (r.gameOver) { console.log(`YOU WIN - fleet sunk. winner: ${r.winner}`); console.log('type "reveal" for the post-game audit, or "quit"'); rl.prompt(); return; }
      const b = cli.botTurn();
      console.log(`ai fires ${b.coord}: ${b.result}`); say();
      if (b.gameOver) { console.log(`AI wins this one. winner: ${b.winner}`); console.log('type "reveal" for the post-game audit, or "quit"'); rl.prompt(); return; }
    } else if (cmd === 'boards') console.log(cli.renderBoards());
    else if (cmd === 'log') console.log(cli.game.shotLog().map((e) => JSON.stringify(e)).join('\n'));
    else if (cmd === 'reveal') {
      const revealed = cli.reveal();
      console.log(`audit on-chain: revealed = ${JSON.stringify(revealed)} - both boards are now provably the committed ones`);
    }
    else if (cmd === 'help') console.log('fire <A1..H8> | boards | log | reveal | help | quit');
    else if (cmd === 'quit' || cmd === 'exit') { rl.close(); return; }
    else if (cmd) console.log('unknown command - try "help"');
  } catch (err) {
    console.log(`error: ${err.message}`);
  }
  rl.prompt();
});

function seedRng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}
