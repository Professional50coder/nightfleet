# nightfleet/contract

Compact smart contract for NightFleet: an 8x8 hidden-fleet game on Midnight with salted board commitments.

- 8 circuits: `joinGame`, `commitBoard`, `fire`, `report`, `claimWin`, `startTimeout`, `claimTimeout`, `revealBoard`
- Witnesses: `localSecretKey`, `myBoard`, `mySalt`
- Fleet: 7 cells on an 8x8 grid; Tier B validity (`fleetCount == 7`) enforced on-chain; hits counted on-ledger; `claimWin` requires 7 reported hits.
- Hardening: `commitBoard` rejects re-committing (`board already committed`) - a published commitment is immutable for the whole game.
- `revealBoard` (post-game audit): after FINISHED, a player proves their exposed board+salt matches the commitment and sets `revealed1`/`revealed2` on-ledger.
- Shot log: every `fire` coordinate is public on-ledger (`pendingShot`) and every hit is a counter delta, so the full transcript is reconstructible for replay; the api also keeps a client-side log (`LocalGame.shotLog()`).
- Liveness: `startTimeout` / `claimTimeout` let the player waiting on an unanswered shot forfeit an opponent who has gone silent. See **Liveness: the unanswered-shot forfeit** below.

## Liveness: the unanswered-shot forfeit

### The gap

Nothing in the game rules compels a defender to call `report()`. Once `fire()` lands, `phase` is `PLAYING`, `pendingShot` is set and `turn` still names the attacker. If the defender never reports, every other circuit is blocked: `fire` reverts on `resolve the pending shot first`, `claimWin` reverts on `opponent fleet is not sunk`, `revealBoard` reverts on `game not finished`. The board is stuck permanently.

This was never a soundness break - no one can win falsely, and no hidden information leaks - but it is a griefing vector: a player who can see they are losing has a free draw available by walking away, and in a live demo a stalled game looks exactly like a broken one.

### What Compact 0.31.1 actually gives you

Any timeout needs a clock. Verified against the pinned toolchain (compiler `0.31.1`, language version `0.23.0`, ledger `ledger-8.0.2`, runtime `0.16.0`) by probe-compiling candidate names:

- The ledger `kernel` exposes exactly two block-time operations, **`kernel.blockTimeGreaterThan(t)`** and **`kernel.blockTimeLessThan(t)`**, both returning `Boolean`, both taking unix seconds.
- There is **no way to read the clock as a value**. `blockTime`, `blockHeight`, `blockNumber`, `secondsSinceEpoch`, `timestamp`, `now`, `time`, `lastBlockTime` are all rejected with `operation ... undefined for ledger field type Kernel`. There is no block height or monotonic counter of any kind.
- The current public docs also list std-lib circuits `blockTimeLt` / `blockTimeLte` / `blockTimeGt` / `blockTimeGte`, which would give the `<=` and `>=` edges the kernel pair lacks. Those belong to a **later** compiler: on 0.31.1 all four are rejected, and only the long kernel spellings compile. Worth revisiting on a toolchain bump - `blockTimeGte` would let `claimTimeout` fire exactly at the deadline rather than strictly after it.

The comparison is a ledger operation, not a private computation, and it is enforced by consensus rather than by the claimant's client. The predicate's result is `popeq`'d into the public transcript; at block-application time the ledger rebuilds the `CallContext` from the including block (`secondsSinceEpoch` sits at index 2 of the context array the VM sees) and re-runs the transcript in verifying mode, where `popeq` arguments are checked for equality instead of gathered. A mismatch is a hard `ReadMismatch` and the transaction is invalid. So a claimant cannot forge an expired deadline: the ZK proof binds the circuit to the transcript, and the node independently recomputes the comparison against the real block clock. This is not a mempool-only check.

The residual trust is narrow and worth stating: the block author supplies `secondsSinceEpoch` as an inherent, within protocol bounds. The threat model is therefore "a dishonest block producer nudges the clock inside consensus bounds", not "any player forges the answer". Midnight's own guidance is to *treat a time gate as accurate to the scale of blocks, not seconds* - a one-hour grace is four orders of magnitude clear of that.

### The design that falls out of it

Because the clock can be compared but not read, a deadline cannot be computed on-chain from "now". So the claimant supplies it and the contract **brackets** it with the two predicates:

```
now < deadline - TIMEOUT_GRACE_SECONDS   =>   deadline > now + GRACE
now > deadline - TIMEOUT_MAX_SECONDS     =>   deadline < now + MAX
```

which pins the supplied value into `[now + GRACE, now + MAX]` without ever reading `now`.

Arming and claiming are split into two circuits:

- **`startTimeout(deadline)`** - only a seated player, only in `PLAYING`, only with a shot pending, only the player `turn` names (while a shot is pending that is the attacker, since `report` is what flips `turn`, so a defender can never start a clock against the person waiting on them), only when no clock is already running. The deadline must be absolute unix seconds (`deadline > TIMEOUT_MAX_SECONDS`, which also makes both subtractions underflow-free) and must survive the bracket above.
- **`claimTimeout()`** - the same guards, plus a running clock, plus `kernel.blockTimeGreaterThan(timeoutDeadline.value)`. On success the claimant becomes `winner` and `phase` goes `FINISHED`.

`report()` clears `timeoutDeadline` along with `pendingShot`, and `fire()` starts every shot with the clock disarmed. `fire` keeps its original signature - the split is what makes that possible, and it means the defender's window starts when the attacker actually complains rather than silently at the instant of the shot.

### Choosing the threshold

`TIMEOUT_GRACE_SECONDS = 3600` (1 hour) is the floor on how long a defender always has once the clock is armed, and it is the only number here that carries real risk. **A tight threshold creates a new attack**: a griefer arms the clock and wins by out-racing an honest but slow defender - bad connectivity, a slow proof, a laptop lid. One hour is deliberately far past any honest response cost (Midnight blocks are seconds apart; a `report` proof is tens of seconds), so nobody at the keyboard can lose to it, while a genuinely absent player still cannot stall the board beyond the hour they were granted. Because the clock only starts when the attacker asks, the window a defender actually sees is (time for the attacker to notice) + one hour, never less.

`TIMEOUT_MAX_SECONDS = 604800` (7 days) is the ceiling. It is a sanity bound rather than a defence - a far-future deadline only delays the claimant's own win - but it keeps the stored deadline anchored to chain time and stops a nonsense value being pinned into ledger state for the rest of the game.

### Residual risk

- **Deadline granularity.** The block context carries an error term, `secondsSinceEpochErr` ("the maximum error on `secondsSinceEpoch`"), but it is not exposed through any Compact op, so a contract cannot factor it in - it can only widen its threshold by hand. There is no published default for it either. The one-hour grace is far past block-scale slop, so it is irrelevant here; a short threshold would not have that luxury.
- **Race at the boundary.** If the defender's `report` and the attacker's `claimTimeout` are both valid in the same window, block ordering decides. This is inherent to any on-chain timeout; the wide grace makes it a non-issue in practice.
- **Other stalls are still open.** This closes the *unanswered shot*. A player who joins and never calls `commitBoard` still parks the game at `OPEN`/`PLACED_1`, and a player whose turn it is who simply never calls `fire` still parks it at `PLAYING` with no pending shot - `startTimeout` requires `pendingShot.is_some`, so neither is covered. Both want the same bracketed-deadline treatment in Wave 3, most likely as a single generic "the player we are waiting on has gone quiet" clock keyed off `turn` and `phase` rather than off `pendingShot`.
- **No draw path.** A timeout always produces a winner. A mutual-abandonment draw, or a stake refund, would need its own circuit.

## Toolchain

From the Midnight support matrix:

- Compact devtools 0.5.1
- Compact compiler 0.31.1
- @midnight-ntwrk/compact-runtime 0.16.0
- @midnight-ntwrk/onchain-runtime-v3 3.0.0
- Node 20+, npm

Install the Compact toolchain with `compact update +0.31.1` (via the midnight-devtools installer), then:

```sh
npm install
npm run compile   # compiles src/nightfleet.compact -> managed/ (git-ignored)
npm test          # vitest: happy-path + adversarial contract tests
```

## Tests

`test/nightfleet.adversarial.test.js` runs 54 cases per docs/14-TESTING-AND-QA.md: full happy-path games (7 hits to `claimWin`, post-game reveal) and adversarial must-revert cases (double join, re-commit mid-game, wrong fleet size, coordinate out of range, firing on the same cell twice, firing before boards are committed, a player reporting on their own board, premature `claimWin`, premature or dishonest `revealBoard`, and more).

The liveness block drives the block clock directly: `runAt(game, priv, time, circuit, ...)` passes `time` as the 7th argument of `createCircuitContext`, which writes `QueryContext.block.secondsSinceEpoch` - the same field the node fills in from the real block. It covers the honest forfeit, claiming before the deadline (and exactly *at* it), a deadline inside the grace window, a deadline past the ceiling, a relative rather than absolute deadline, the defender trying to arm or claim, a stranger trying to arm or claim, no pending shot, no armed clock, re-arming a running clock, a timely `report` disarming the clock, timing out a `FINISHED` game, and a normal game still finishing unchanged.
