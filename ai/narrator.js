// @nightfleet/ai - referee-narrator (docs/06-INTELLIGENT-LAYER.md §3).
// Turns invisible ZK into a visible story: one plain-English line per public
// event saying what was proven and what stayed hidden.
//
// Privacy guardrail: the narrator accepts ONLY whitelisted public event shapes
// (commit/fire/report/win) - it never sees a board, salt, or key, and unknown
// event types throw instead of being narrated.
//
// The LLM is optional polish: with no client, or on any error/deadline, the
// cached template line is used, so narration never blocks a turn.

import { formatCoordinate } from '../shared/index.js';

// Public event whitelist. Anything else is not narratable.
const PUBLIC_EVENTS = Object.freeze(['commit', 'fire', 'report', 'win']);

function coordText(coord) {
  if (typeof coord === 'string') return coord.toUpperCase();
  return formatCoordinate(coord); // {x, y} -> A1..H8
}

const TEMPLATES = {
  commit: (e) =>
    `${e.player} locked in their fleet. From here, every answer is proven against that commitment - not taken on trust.`,
  fire: (e) =>
    `${e.player} fires at ${coordText(e.coord)}. The answer will come back with a proof checked against the board committed at the start.`,
  report: (e) => e.result === 'hit'
    ? `${coordText(e.coord)} -> HIT. The proof confirms ${coordText(e.coord)} holds part of a ship on the fleet your opponent locked in at the start - the rest of their ships stay completely hidden.`
    : `${coordText(e.coord)} -> MISS. The proof confirms ${coordText(e.coord)} is empty on the fleet your opponent locked in at the start - their ship positions are still completely hidden.`,
  win: (e) =>
    `${e.player} wins. Every hit this game was proven against the fleet committed before the first shot - the losing board can now be revealed for audit.`,
};

// doc §3 prompt shape, kept for the optional LLM path
export const NARRATOR_SYSTEM_PROMPT =
  "You are NightFleet's referee. In ONE sentence, explain to a non-crypto player " +
  'what the last move proved and what remained private. Never reveal hidden board data.';

function key(e) {
  return [e.type, e.player ?? '', e.coord ? coordText(e.coord) : '', e.result ?? ''].join('|');
}

function templateLine(e) {
  return TEMPLATES[e.type](e);
}

/**
 * @param {{ llm?: { generate: (system: string, input: object) => Promise<string> }, deadlineMs?: number }} opts
 *   llm is any client with generate(systemPrompt, publicInput). Only whitelisted
 *   public fields are ever passed to it.
 */
export function createNarrator({ llm = null, deadlineMs = 4000 } = {}) {
  const cache = new Map();

  function sanitize(e) {
    if (!e || !PUBLIC_EVENTS.includes(e.type)) {
      throw new RangeError(`narrator only speaks public events (${PUBLIC_EVENTS.join('/')}); got "${e?.type}"`);
    }
    const out = { type: e.type };
    if (e.player !== undefined) out.player = String(e.player);
    if (e.coord !== undefined) out.coord = coordText(e.coord);
    if (e.result !== undefined) {
      if (e.result !== 'hit' && e.result !== 'miss') throw new RangeError(`bad result "${e.result}"`);
      out.result = e.result;
    }
    return out;
  }

  return {
    /** Sync narration from templates + cache. Never throws for valid public events. */
    narrate(event) {
      const e = sanitize(event);
      const k = key(e);
      if (!cache.has(k)) cache.set(k, templateLine(e));
      return cache.get(k);
    },

    /**
     * Async narration: LLM line when a client is configured, else the template.
     * Any LLM error or deadline miss falls back to the template - gameplay never waits.
     * @returns {Promise<string>}
     */
    async narrateAsync(event) {
      const e = sanitize(event);
      const k = key(e);
      if (cache.has(k)) return cache.get(k);
      let line = templateLine(e);
      if (llm) {
        try {
          const publicInput = { ...e, committedAt: 'game start' };
          const generated = await Promise.race([
            llm.generate(NARRATOR_SYSTEM_PROMPT, publicInput),
            new Promise((_, reject) => setTimeout(() => reject(new Error('narrator deadline')), deadlineMs)),
          ]);
          if (typeof generated === 'string' && generated.trim().length > 0) line = generated.trim();
        } catch { /* fall back to template */ }
      }
      cache.set(k, line);
      return line;
    },

    get cacheSize() { return cache.size; },
  };
}
