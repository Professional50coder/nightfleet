<p align="center"><img src="brand/moon.svg" width="72" alt="NightFleet moon"></p>

<h1 align="center">NightFleet Roadmap</h1>
<p align="center"><strong>Where the fleet sails next.</strong></p>

This file is the living plan. It separates what is shipped and verifiable
today from what is in flight, so judges, players, and contributors never have
to guess.

---

## Phase 0 · SHIPPED (hackathon submission)

Everything in this phase is in the repo, tested, and reproducible from a
fresh clone.

| Deliverable | Proof |
|---|---|
| Compact contract: 6 circuits, private witnesses, public commitments | `contract/src/nightfleet.compact`, compiles under pinned `compactc 0.31.1` |
| 54-case adversarial suite: every cheat vector fails its proof | `contract/test/nightfleet.adversarial.test.js` |
| Shared deterministic rules engine (contract, CLI, and browser run the same rules) | `shared/`, 36 tests |
| Full game loop API with replayable action log | `api/`, drives every surface |
| Terminal game vs AI | `cli/`, `npm run play`, 78 tests |
| Browser game | [nightfleet.vercel.app](https://nightfleet.vercel.app) |
| AI opponent, 3 deterministic tiers + referee narrator | `ai/`, plays through the real game API |
| Lace wallet detection, redaction, Preprod guard | `wallet/`, 132 tests |
| **267 automated tests, all green** | `npm test` per package |
| Demo video + submission deck | README embed, linked deck |

## Phase 1 · IN FLIGHT (submission window)

| Work item | Status |
|---|---|
| Midnight **Preprod** deployment with real ZK proofs (official proof server, funded test wallet) | **Done** - contract `15bd24d16878cfc5ee2537223ddd41a13f0ca451c1d64b796a4643b87c94bab6`, confirmed via the preprod indexer |
| Contract address + on-chain verification steps added to README | **Done** - see "Live on Preprod" in the README |
| Demo video v3 with burned-in captions | **Done** - embedded in the README and attached to the repo's demo-video release |
| Submission form (Midnight Korea) | Owner submitting |

## Phase 2 · NEXT (post-submission, in priority order)

1. **On-chain two-player matches (squad links).** Player A creates a game on
   Preprod from the browser - Lace connects, proves, and deploys a fresh
   contract instance - and shares the squad link, which carries the contract
   address. Player B opens the link, connects Lace, and joins the same
   contract. Both fleets committed on-chain, every turn proven, no server in
   the middle. The contract already runs the full two-player loop
   (`joinGame` seats two players by derived key; `commitBoard`, `fire`,
   `report`, `claimWin`, and the timeout circuits all gate on seated keys),
   and the app's driver seam (`app/src/game/midnight-driver.js`) is built for
   exactly this driver - so every existing feature stays as it is.
2. **Multiplayer lobby.** Open games list, rematch flow, and player handles
   resolved through Lace.
3. **Spectator mode.** Watch a live match from the public ledger state:
   commitments, shots, and proven results stream in without ever seeing a
   fleet until reveal.
4. **Tournament brackets.** Commit-reveal seeded brackets where every round
   is audited on-chain and the bracket itself cannot be rigged by the
   organizer.

## Phase 3 · LATER (ecosystem maturity)

- **Mobile-first PWA** build of the browser game.
- **Replay explorer**: paste any finished game's salt, verify the full board
  against the commitment, replay every turn with its proof.
- **Reference-implementation track**: extract NightFleet's patterns (witness
  design, commit-reveal discipline, adversarial test suite shape, shared rules
  engine) into standalone docs and templates for every team building
  private-state consumer apps on Midnight.

## Hard boundaries (will not change)

- **Preprod/testnet only.** The code refuses mainnet by construction.
- **No real-money wagering.** Out of scope by policy, permanently.
- **Privacy is the product.** No feature ships that moves fleet data off the
  player's device before reveal.

---

*Updated during the Midnight Korea hackathon, September 2026.*
