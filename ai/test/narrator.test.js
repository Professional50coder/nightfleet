// Narrator tests (docs/06 §3): template lines, cache, LLM fallback, privacy.
import { describe, it, expect, vi } from 'vitest';
import { createNarrator, NARRATOR_SYSTEM_PROMPT } from '../narrator.js';

describe('narrator templates', () => {
  const n = createNarrator();

  it('report miss names the coordinate, the proof, and what stays hidden', () => {
    const line = n.narrate({ type: 'report', coord: 'd4', result: 'miss' });
    expect(line).toContain('D4');
    expect(line).toContain('MISS');
    expect(line).toMatch(/proof/i);
    expect(line).toMatch(/hidden/i);
  });

  it('report hit differs and stays hidden-aware', () => {
    const line = n.narrate({ type: 'report', coord: { x: 0, y: 0 }, result: 'hit' });
    expect(line).toContain('A1');
    expect(line).toContain('HIT');
    expect(line).toMatch(/hidden/i);
  });

  it('commit and win events narrate the commitment story', () => {
    expect(n.narrate({ type: 'commit', player: 'alice' })).toMatch(/alice.*locked in/i);
    expect(n.narrate({ type: 'win', player: 'bob' })).toMatch(/bob wins/i);
    expect(n.narrate({ type: 'fire', player: 'alice', coord: { x: 1, y: 1 } })).toContain('B2');
  });

  it('caches by event identity', () => {
    const m = createNarrator();
    const before = m.cacheSize;
    const a = m.narrate({ type: 'report', coord: 'C3', result: 'hit' });
    const b = m.narrate({ type: 'report', coord: 'C3', result: 'hit' });
    expect(a).toBe(b);
    expect(m.cacheSize).toBe(before + 1);
    m.narrate({ type: 'report', coord: 'C4', result: 'hit' });
    expect(m.cacheSize).toBe(before + 2);
  });
});

describe('narrator guardrails', () => {
  const n = createNarrator();

  it('refuses non-public event types', () => {
    expect(() => n.narrate({ type: 'board', board: [1, 2, 3] })).toThrow(RangeError);
    expect(() => n.narrate({ type: 'reveal' })).toThrow(/public events/);
    expect(() => n.narrate({})).toThrow(RangeError);
  });

  it('never leaks non-whitelisted fields into output or the LLM input', async () => {
    const spy = vi.fn().mockResolvedValue('llm line');
    const m = createNarrator({ llm: { generate: spy } });
    await m.narrateAsync({ type: 'report', coord: 'E5', result: 'hit', board: [1, 1, 1], salt: 'deadbeef' });
    const input = spy.mock.calls[0][1];
    expect(JSON.stringify(input)).not.toContain('deadbeef');
    expect(input).not.toHaveProperty('board');
    expect(input).toEqual({ type: 'report', coord: 'E5', result: 'hit', committedAt: 'game start' });
    expect(NARRATOR_SYSTEM_PROMPT).toMatch(/never reveal hidden board data/i);
  });

  it('rejects a bad result value', () => {
    expect(() => n.narrate({ type: 'report', coord: 'A1', result: 'sunk' })).toThrow(RangeError);
  });
});

describe('narrator LLM path', () => {
  it('uses the LLM line when it answers in time', async () => {
    const spy = vi.fn().mockResolvedValue('  D4 splashed wide - proof checked.  ');
    const m = createNarrator({ llm: { generate: spy } });
    const line = await m.narrateAsync({ type: 'report', coord: 'D4', result: 'miss' });
    expect(line).toBe('D4 splashed wide - proof checked.');
    expect(spy).toHaveBeenCalledTimes(1);
    // cached: second call does not hit the LLM again
    await m.narrateAsync({ type: 'report', coord: 'D4', result: 'miss' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the template when the LLM errors', async () => {
    const m = createNarrator({ llm: { generate: vi.fn().mockRejectedValue(new Error('429 quota')) } });
    const line = await m.narrateAsync({ type: 'report', coord: 'F6', result: 'miss' });
    expect(line).toContain('F6');
    expect(line).toContain('MISS');
  });

  it('falls back to the template when the LLM misses its deadline', async () => {
    const slow = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const m = createNarrator({ llm: { generate: slow }, deadlineMs: 25 });
    const line = await m.narrateAsync({ type: 'fire', player: 'ai', coord: { x: 7, y: 7 } });
    expect(line).toContain('H8');
  }, 3000);
});
