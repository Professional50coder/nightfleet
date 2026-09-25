# `app/` — NightFleet web client

React + Vite frontend for NightFleet. Place a fleet, fire at a fogged enemy grid, watch the
referee explain what each answer proved and what stayed hidden.

```bash
cd nightfleet/app
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/
npx vitest run   # 75 tests
```

Node 20+. No network access is needed at runtime: there is no webfont, no API key and no
backend. The AI opponent and the referee narration both run locally.

---

## What works today

- **Fleet placement** — 8×8 grid, the `[3,2,2]` fleet, click-to-place, click-to-lift,
  <kbd>R</kbd> to rotate, auto-place, clear. Commit stays disabled until the layout passes
  `assertValidFleet` from `shared/` — the same assertion `commitBoard()` makes on-chain.
- **Battle** — your waters (fleet visible, incoming shots marked) beside enemy waters (fog).
  Turn indicator, hit/miss meters, shot log, last-shot readout.
- **Opponent** — `ai/opponent.js`, unmodified: deterministic and seeded, so a seed replays a
  game exactly. Easy / medium / hard.
- **Referee narration** — `ai/narrator.js` template path. No API key, no network call.
- **Reveal & audit** — after the game, open both boards and check them against the
  commitments. Refused before the game is finished.
- **Keyboard and screen readers** — every cell is a real focusable button with an ARIA label
  (`"C4, hit"`), arrow keys move focus across the grid, hit/miss carry a glyph as well as a
  colour, and `prefers-reduced-motion` is honoured.

## What does *not* work yet, and why

**No proofs are generated and nothing touches a ledger.** The UI says so — the HUD reads
"◇ local rules", not "🔒 proof-backed", and the "why can't they cheat?" panel spells out that
this session runs the rules locally. That honesty is deliberate: see the seam below.

Also not here: Lace wallet connect (owned elsewhere), PvP, spectator replay of a real
contract, Preprod deploy.

---

## The driver seam

This is the part of the app worth reading first: `src/game/driver.js`.

### The problem

`api/LocalGame` already drives the five real circuits through
`@midnight-ntwrk/compact-runtime`. That runtime is **Node-side** — it loads the compiled ZK
assets from `contract/managed/` and reaches for `node:crypto`. It will not run in a browser
bundle, and shimming it in buys a broken build rather than a game.

So the UI never imports `api/`. It talks to an interface, and the implementation behind that
interface is swappable.

```
              ┌───────────────────────────────┐
  components  │  useGame()  (hooks/useGame.js)│   the only place the UI touches a driver
      ▲       └───────────────┬───────────────┘
      │                       │ interface only
      │            ┌──────────┴──────────┐
      │            │   GameDriver        │   driver.js — methods, state shape, fog rule
      │            └──────────┬──────────┘
      │              ┌────────┴────────┐
      │              │                 │
  BrowserLocalDriver              MidnightDriver  (declared, not implemented)
  local-driver.js                 midnight-driver.js
   • shared/ rules                 • will speak to a Node host / Lace + proof server
   • ai/opponent.js seat           • which speaks to api/LocalGame
   • no proofs, no chain           • which drives contract/managed + the prover
```

### The interface

Every method is `async`. The browser driver resolves immediately; a proving driver will take
seconds. The UI awaits either without changing a line.

| Method | Maps to (future proof-backed driver) |
|---|---|
| `describe()` | static — what is backing this game, and is it available |
| `newGame(opts)` | `LocalGame.create()` + `addPlayer()`, or join a deployed address |
| `commitFleet(board)` | `game.commitBoard(handle, board, salt)` |
| `fire(coord)` | `game.fire(...)` then await the defender's `report()` |
| `getState()` | `game.state()`, projected through the fog rule |
| `getShotLog()` | `game.shotLog()` |
| `getNarration()` | client-side, from `ai/narrator.js` |
| `revealFleets()` | `game.revealBoard(handle)` |
| `subscribe(fn)` | indexer WS subscription |

`assertDriverShape(driver)` enforces the method list, and `test/driver.test.js` runs its
conformance block over *every* registered driver — so a new implementation cannot be listed in
`src/game/drivers.js` without satisfying the same shape.

### The fog rule

`getState().opponent` describes **only cells you have fired at**. Everything else is
`MARK.UNKNOWN`, and no other field may let you deduce it — no per-row ship counts, no "ships
remaining" shapes, no board. The opponent's layout leaves the driver in exactly one place,
`revealFleets()`, which is gated on the game being `FINISHED`.

In `BrowserLocalDriver` this is enforced by the language, not by discipline: the opponent
board is a `#private` class field, so it cannot be enumerated, reflected over or serialised out
of the object. `test/fog-of-war.test.jsx` asserts the property directly — after every round of
a complete game it walks the public state for any 64-length array matching the hidden fleet,
checks every non-fog mark against the set of cells actually fired at, and checks that the shot
log and the narration mention no coordinate that was not fired at.

**This is a privacy property, not a nicety.** A future proof-backed driver gets the guarantee
from the contract (`report()` discloses one cell), so its job is not to re-derive it but to
avoid *widening* it — by passing a debug field through, or by caching a revealed board and
serving it early. The fog tests are written against the interface for exactly that reason.

### Adding the real driver

1. Implement the class in `src/game/midnight-driver.js` (transport + `getState()` projection).
2. Register it in `src/game/drivers.js` with `available: true`.
3. Run `npx vitest run`. The conformance and fog suites apply to it unchanged.

Nothing in `src/components/` or `src/App.jsx` should need to change.

---

## Layout

```
src/
  game/
    protocol.js        re-exports shared/ + presentation vocabulary (MARK, PHASE, SEAT)
    placement.js       ship-level placement model; validation ends in assertValidFleet
    driver.js          THE SEAM: interface, DriverError, fog rule, UnavailableDriver
    local-driver.js    BrowserLocalDriver — playable today
    midnight-driver.js MidnightDriver — declared stub, documents the mapping to api/
    drivers.js         registry the UI picks from
  hooks/useGame.js     the only consumer of a driver
  components/          Board, FleetSetup, Battle, Hud, ShotLog, Narrator, Result, Home
  styles/              tokens.css (design tokens) + app.css
test/                  placement · driver · fog-of-war · components
```

### Design decisions

Worth knowing, all deliberate:

- **Plain JS + JSX, not TypeScript.** Every other package in `nightfleet/` is plain ESM JS and
  `shared/` is consumed by relative import; mixing a TS build in for one package added setup
  without adding safety here. Types are documented in JSDoc on the driver interface.
- **Hand-written CSS, not Tailwind + shadcn.** The palette, mono-for-everything-ID-shaped rule
  and hairline depth are implemented as CSS custom properties in
  `src/styles/tokens.css`. Porting the LightNote component library is a later step; this keeps
  the dependency list to React + Vite + Vitest.
- **CSS transitions, not Framer Motion.** Spring easing, hover lift, press compression and
  reduced-motion support are all in `app.css`. The heavier motion set
  (proof shimmer, hit shatter, confetti) belongs with the driver that actually proves things.
- **`shared/` and `ai/` are imported by relative path**, exactly as `api/` and `cli/` do.
  `vite.config.js` sets `server.fs.allow` so the dev server can serve them.
