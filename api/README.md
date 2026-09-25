# nightfleet/api

Typed local-stack API over the compiled NightFleet contract (Phase 1). Drives
the contract in-process via `@midnight-ntwrk/compact-runtime`; on-chain
transport (node + proof server + Lace fallback) plugs in behind the same
interface at M1.

## Prereqs

```sh
cd ../contract && npm install && npm run compile   # produces managed/ (git-ignored)
cd ../api && npm install
```

## Usage

```js
import { LocalGame } from './local-game.js';

const game = LocalGame.create();
const alice = game.addPlayer('alice');
const bob = game.addPlayer('bob');
game.commitBoard(alice, boardA, saltA);   // board: Array<64> of 0|1, exactly 7 cells
game.commitBoard(bob, boardB, saltB);
game.fire(alice, { x: 1, y: 2 });         // throws GameError on any contract revert
game.report(bob);                         // 'hit' | 'miss'
game.claimWin(alice);                     // once 7 hits landed
game.revealBoard(alice);                  // post-game audit, sets revealed flag
```

## Surface

- `LocalGame.create()` / `addPlayer(name)` -> handle
- `commitBoard(handle, board, salt?)` -> commitment hex (fleet validated client-side first)
- `fire(handle, {x, y})`, `report(handle)` -> `'hit'|'miss'`, `claimWin(handle)` -> winner name
- `revealBoard(handle)` -> `{ name: boolean }` reveal map
- `state()` -> `{ phase, turn, pendingShot, hitsLanded, revealed, winner }`
- `shotLog()` -> replayable action transcript; `LocalGame.replay(log)` rebuilds the game
- Contract reverts surface as `GameError` with the on-chain assert text

## Tests

```sh
npx vitest run   # full game, commitment determinism, transcript replay, reveal flow
```
