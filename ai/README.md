# nightfleet/ai

The intelligent layer: deterministic AI opponent
and referee-narrator. Pure JS, seeded, no LLM in the move path - the model is
reserved for narration, so a flaky API can never break gameplay.

## Opponent

- `new Opponent({ difficulty, seed })` - shot engine. `nextShot()` returns the
  next `{x, y}`; `recordShot(coord, 'hit'|'miss')` feeds the contract's answer
  back. Throws on double-shot, bad result, or exhausted board.
- Difficulty tiers: `easy` (random), `medium` (parity hunt, then orthogonal
  target + line-follow), `hard` (probability-density over the remaining fleet
  shapes, biased to unresolved hits).
- `opponentFleet(seed)` - seeded valid fleet for the AI's own commitment.
- `new GamePlayer(game, name, opts)` - a seat at a real `LocalGame`: joins,
  `commitSeat()` commits its own board + salt, and `takeTurn(defenderHandle)`
  fires/reports through the same api path as a human. No fake mode. Both seats
  must join before anyone commits (contract phase rule).

The contract reports only hit/miss (no sink events), so targeting treats every
hit as unresolved until its line can no longer extend.

## Narrator

- `createNarrator({ llm?, deadlineMs? })` - one plain-English line per public
  event saying what was proven and what stayed hidden.
- `narrate(event)` - sync template line, cached by event identity.
- `narrateAsync(event)` - LLM line when a client with
  `generate(systemPrompt, publicInput)` is configured; on any error or deadline
  miss it falls back to the template, so narration never blocks a turn.
- Privacy by construction: only whitelisted public events (`commit`, `fire`,
  `report`, `win`) are narratable - unknown types throw, and only whitelisted
  fields are ever passed to the LLM.

## Tests

```sh
npx vitest run   # engine tiers/determinism, narrator guardrails + fallback,
                 # full games through LocalGame
```
