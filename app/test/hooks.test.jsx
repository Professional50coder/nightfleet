// The two app hooks, tested directly (docs/14 section 1: frontend layer covers
// state transitions and error states, not just rendered markup).
//
// useGame is the only place the UI touches a driver: these tests pin the
// contract the battle screen relies on - calls forwarded, state refreshed after
// every call, busy/error bookkeeping, and live refresh when the driver pushes.
// useReveal is the scroll-reveal kit item: these tests pin the honesty rule at
// the hook level - content is never trapped behind the effect.
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { useGame } from '../src/hooks/useGame.js';
import { useReveal } from '../src/hooks/useReveal.js';
import { DriverError, PHASE } from '../src/game/driver.js';

function createMockDriver() {
  const listeners = new Set();
  const driver = {
    calls: [],
    state: null,
    log: [],
    narration: [],
    async describe() {
      return {
        id: 'mock', name: 'Mock', provesMoves: false, onChain: false,
        summary: 'a mock driver', available: true,
      };
    },
    async newGame(opts) { driver.calls.push(['newGame', opts]); },
    async commitFleet(board) { driver.calls.push(['commitFleet', board]); },
    async fire(coord) { driver.calls.push(['fire', coord]); },
    async getState() { return driver.state; },
    async getShotLog() { return driver.log; },
    async getNarration() { return driver.narration; },
    async revealFleets() { driver.calls.push(['revealFleets']); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    push() { for (const fn of [...listeners]) fn(); },
  };
  return driver;
}

const finishedState = { phase: PHASE.FINISHED, turn: null, winner: 'you' };

describe('useGame', () => {
  it('describes the driver on mount and defaults to the OPEN phase without state', async () => {
    const driver = createMockDriver();
    const { result } = renderHook(() => useGame({ createDriver: () => driver }));

    await waitFor(() => expect(result.current.info?.id).toBe('mock'));
    expect(result.current.state).toBeNull();
    expect(result.current.phase).toBe(PHASE.OPEN);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('forwards calls to the driver and refreshes state, narration, and log after each', async () => {
    const driver = createMockDriver();
    const { result } = renderHook(() => useGame({ createDriver: () => driver }));

    await act(async () => { await result.current.newGame({ seed: 7, difficulty: 'hard' }); });
    await act(async () => { await result.current.commitFleet([0, 1, 2]); });
    await act(async () => { await result.current.fire({ x: 3, y: 4 }); });
    await act(async () => { await result.current.revealFleets(); });

    expect(driver.calls).toEqual([
      ['newGame', { seed: 7, difficulty: 'hard' }],
      ['commitFleet', [0, 1, 2]],
      ['fire', { x: 3, y: 4 }],
      ['revealFleets'],
    ]);

    driver.state = finishedState;
    driver.narration = ['game over'];
    driver.log = [{ seq: 1, circuit: 'claimWin', seat: 'you' }];
    await act(async () => { await result.current.refresh(); });
    expect(result.current.state).toEqual(finishedState);
    expect(result.current.phase).toBe(PHASE.FINISHED);
    expect(result.current.narration).toEqual(['game over']);
    expect(result.current.log).toHaveLength(1);
  });

  it('shows DriverError messages verbatim and dismisses them', async () => {
    const driver = createMockDriver();
    driver.fire = async () => { throw new DriverError('not your turn'); };
    const { result } = renderHook(() => useGame({ createDriver: () => driver }));

    await act(async () => { await result.current.fire({ x: 0, y: 0 }); });
    expect(result.current.error).toBe('not your turn');
    expect(result.current.busy).toBe(false);

    act(() => { result.current.dismissError(); });
    expect(result.current.error).toBeNull();
  });

  it('stringifies non-driver failures instead of leaking raw objects', async () => {
    const driver = createMockDriver();
    driver.newGame = async () => { throw new Error('kaboom'); };
    const { result } = renderHook(() => useGame({ createDriver: () => driver }));

    await act(async () => { await result.current.newGame({}); });
    expect(result.current.error).toBe('kaboom');
  });

  it('holds busy for the whole driver call and releases it after', async () => {
    const driver = createMockDriver();
    let release;
    driver.commitFleet = () => new Promise((resolve) => { release = resolve; });
    const { result } = renderHook(() => useGame({ createDriver: () => driver }));

    let pending;
    act(() => { pending = result.current.commitFleet([1, 2]); });
    await waitFor(() => expect(result.current.busy).toBe(true));

    await act(async () => { release(); await pending; });
    expect(result.current.busy).toBe(false);
  });

  it('refreshes when the driver pushes an update', async () => {
    const driver = createMockDriver();
    const { result } = renderHook(() => useGame({ createDriver: () => driver }));
    await waitFor(() => expect(result.current.info?.id).toBe('mock'));

    driver.state = finishedState;
    await act(async () => { driver.push(); });
    expect(result.current.state).toEqual(finishedState);
  });

  it('rejects a driver that does not satisfy the shape', () => {
    expect(() => renderHook(() => useGame({ createDriver: () => ({}) }))).toThrow();
  });
});

describe('useReveal (docs/18 section 4 kit: scroll-reveal)', () => {
  function RevealProbe() {
    const ref = useReveal();
    return <div ref={ref} className="reveal">probe</div>;
  }

  class MockIO {
    static instances = [];
    constructor(cb) {
      this.cb = cb;
      this.observed = new Set();
      this.unobserved = [];
      MockIO.instances.push(this);
    }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.unobserved.push(el); }
    disconnect() { this.disconnected = true; }
  }

  it('reveals on first intersection, then stops observing', () => {
    MockIO.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIO);
    const { container } = render(<RevealProbe />);
    const el = container.querySelector('.reveal');

    // Not revealed before it scrolls into view - but observed.
    expect(el).not.toHaveClass('is-revealed');
    expect(MockIO.instances).toHaveLength(1);
    expect(MockIO.instances[0].observed.has(el)).toBe(true);

    act(() => { MockIO.instances[0].cb([{ isIntersecting: true, target: el }]); });
    expect(el).toHaveClass('is-revealed');
    expect(MockIO.instances[0].unobserved).toEqual([el]);
  });

  it('reveals immediately under reduced motion, without an observer', () => {
    MockIO.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIO);
    vi.stubGlobal('matchMedia', (query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const { container } = render(<RevealProbe />);

    expect(container.querySelector('.reveal')).toHaveClass('is-revealed');
    expect(MockIO.instances).toHaveLength(0);
  });

  it('reveals immediately when IntersectionObserver is unavailable', () => {
    const { container } = render(<RevealProbe />);
    expect(container.querySelector('.reveal')).toHaveClass('is-revealed');
  });
});
