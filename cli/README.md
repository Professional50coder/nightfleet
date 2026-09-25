# nightfleet/cli

Interactive NightFleet on the local stack: human vs scripted opponent, driven
through @nightfleet/api's LocalGame over the compiled contract. This is the
Phase 1 DoD "full game via CLI on local stack, reproducible".

## Prereqs

```sh
cd ../contract && npm install && npm run compile   # produces managed/
cd ../api && npm install
```

## Play

```sh
node play.js          # interactive
node play.js --demo   # deterministic scripted game (seeded), for demos/tests
```

Commands: `fire B3`, `boards`, `log`, `help`, `quit`.
Fleets are auto-placed; your board is committed on-ledger (hash of board+salt)
and stays local - the same privacy model as the contract.

## Deploy

`deploy.js` deploys the compiled contract to a Midnight network and records the
**contract address** and **deploy transaction** - the judges' proof of a real
deployment (docs/07 section 4).

```sh
node deploy.js --dry-run                        # validate everything, deploy nothing
node deploy.js --network local   --confirm      # midnight-local-dev stack
node deploy.js --network preprod --confirm      # Preprod (the submission target)
```

| flag | meaning |
| --- | --- |
| `--network <local\|preprod>` | target network (default `preprod`) |
| `--dry-run` | validate config + artifacts, print the plan, touch nothing |
| `--confirm` | required for a real deploy; without it the command refuses |
| `--managed <dir>` | compiled contract dir (default `../contract/managed`) |
| `--out <file>` | deployment record (default `../shared/deployments.json`) |
| `--json` | machine-readable output |

A bare `node deploy.js` is treated as `--dry-run`: deploying is never the
accidental default. Exit codes are distinct per failure mode - `2` config,
`3` missing artifacts, `4` no wallet, `5` not confirmed, `6` deploy failed.

On success the record is merged into `shared/deployments.json`, keyed by
network, so a local and a Preprod deployment coexist:

```json
{
  "updatedAt": "…",
  "deployments": {
    "preprod": { "contractAddress": "…", "txId": "…", "blockHeight": 0,
                 "deployedAt": "…", "endpoints": { … }, "versions": { … } }
  }
}
```

### Dry run

`--dry-run` is the part that works **today**, with no Docker and no wallet. It
resolves and validates the network config, checks `contract/managed/` (which is
gitignored and may be absent), and prints the exact steps a real deploy would
take plus every remaining blocker. It never opens a socket and never writes a
file.

### Environment

Every endpoint has a default (docs/07 section 5) and an override. Config comes
from the environment only - nothing is hardcoded into a committed file.

| variable | overrides |
| --- | --- |
| `NIGHTFLEET_NETWORK` | network name (`local` / `preprod`) |
| `NIGHTFLEET_NETWORK_ID` | network id (`undeployed` / `preprod`) |
| `NIGHTFLEET_NODE_URL` | node RPC endpoint |
| `NIGHTFLEET_INDEXER_URL` | indexer GraphQL (http) |
| `NIGHTFLEET_INDEXER_WS_URL` | indexer GraphQL (ws) |
| `NIGHTFLEET_PROOF_SERVER_URL` | proof server (local Docker, `:6300`) |
| `NIGHTFLEET_EXPLORER_URL` | explorer base url; enables address/tx links |
| `NIGHTFLEET_NODE_WS_URL` | node WebSocket url; defaults to the RPC url with the scheme swapped |
| `NIGHTFLEET_WALLET_SEED` | **secret** - deploy wallet seed (hex, BIP32 master) |
| `NIGHTFLEET_PRIVATE_STATE_PASSWORD` | **secret** - encrypts the local private-state store |

`NIGHTFLEET_PRIVATE_STATE_PASSWORD` is required for a real deploy. It encrypts
the LevelDB that holds the contract maintenance signing key, so losing it means
the deployed contract can never be maintained again. The SDK enforces at least
16 characters, 3 of upper/lower/digit/special, and no run of 4 sequential
characters.

`NIGHTFLEET_WALLET_SEED` is read at the point of signing only. It is never
copied into the config, never written to `deployments.json`, and never printed -
there are tests asserting exactly that. Keep it in `.env`, which is gitignored,
and **never commit it**.

### Still blocked (be clear about this)

A real Preprod deploy cannot run yet. The code path is written end to end, but
three things are on the user, not the code:

1. **Docker Desktop** with WSL integration, running the proof server on
   `localhost:6300` (docs/02-SETUP.md step 3). The image tag still needs pinning
   to the ledger/prover version - the dry run flags this as a blocker.
2. **A funded wallet on Preprod** - fund it from
   https://midnight-tmnight-preprod.nethermind.dev/ and export the hex master
   seed to `NIGHTFLEET_WALLET_SEED`.
3. **The `@midnight-ntwrk/*` deploy packages**, pinned to the support-matrix
   line in `shared/network.js` (`PINNED_VERSIONS`). The real provider refuses to
   run until every one of them resolves.

`contract/managed/` must also exist (`cd ../contract && npm run compile`); it is
gitignored, so it is absent on a fresh clone.

> **The wallet package in docs/07 is wrong.** `@midnight-ntwrk/wallet` is not
> the wallet for this midnight-js line: its shipping major (5.0.0) is built on
> `@midnight-ntwrk/zswap@4` and its `balanceTransaction` cannot take the
> ledger-v8 `UnboundTransaction` that midnight-js 4.1.1's `WalletProvider`
> requires. The deploy path uses the `@midnight-ntwrk/wallet-sdk` barrel
> (`WalletFacade`) instead. `REQUIRED_PACKAGES` in `deploy.js` is the list that
> is actually correct.

### What is verified, and what is not

Everything in `deploy.js` is written against a type signature read from the
installed package at the pinned version - not from prose. What has **not**
happened is a single real execution: there is no Docker, no proof server and no
funded wallet on the machine this was written on, so `deployContract` has never
run once. Specifically unverified, and what would settle each:

| assumption | what would verify it |
| --- | --- |
| the assembled provider set actually deploys | `node deploy.js --network local --confirm` against midnight-local-dev |
| node WebSocket URL derived from the RPC URL by swapping the scheme | one wallet sync against Preprod; override with `NIGHTFLEET_NODE_WS_URL` |
| `feeBlocksMargin: 5` / `additionalFeeOverhead: 0n` (the SDK's own defaults) | one deploy that is not rejected for underpaying |
| the compiled `managed/contract/index.js` binds to `CompiledContract.make()` | one `deployContract` call that gets as far as proving |

The test suite exercises this wiring through injected fakes. That proves the
arguments are the ones intended - the plumbing - and nothing more. A green run
is **not** evidence that a Preprod deploy will succeed.

### Provider seam

Everything external - wallet, proof server, indexer, node - sits behind one
injected interface, which is why the flow above is fully testable with none of
it present:

```js
DeployProvider = {
  name,
  probe(): Promise<Record<string, { ok: boolean, detail?: string }>>,
  deploy({ config, artifacts }): Promise<{ contractAddress, txId, blockHeight? }>,
  close?(): Promise<void>,
}
```

`runDeploy()` also takes injected `fs`, `log`, `errorLog` and `now`, so no test
touches the real filesystem, clock or terminal. Receipts coming back from a
provider are validated before anything is recorded - a provider that returns no
address or no tx id cannot write a deployment file.

## Known limitation: a defender can stall the game forever

Nothing in the contract compels a defender to call `report()`. After an
attacker calls `fire`, the game sits in `PLAYING` with a `pendingShot` until the
defender responds - and a player who is losing can simply stop responding. There
is no timeout, no forfeit path and no way for the attacker to force progress, so
the game stalls in `PLAYING` permanently.

This is **not a soundness break**: no one can win falsely, no board is revealed,
and every claim still has to carry a proof. It is a *liveness* gap, and it is a
griefing vector - the losing player's cheapest move is to walk away. It would
also be visible in a live demo, because a stalled game looks identical to a
hung one.

Fixing it means a deadline in the contract (a block-height or turn timeout
after which the attacker can claim a forfeit), which is a contract change and
is tracked separately. Nothing in this CLI can work around it.

## Tests

```sh
npx vitest run
```

Covers: scripted game to a winner, duplicate-shot rejection, placement
required before firing, board rendering; and for deploy - config validation and
env overrides, missing-artifact / missing-wallet / unconfirmed failure modes,
dry-run output, and the full deploy flow against a mock provider (success,
preflight failure, deploy failure, junk receipt).

`test/engine.test.js` needs `contract/managed/`, so compile the contract first;
`test/deploy.test.js` needs nothing and runs on a bare clone.
