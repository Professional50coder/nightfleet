// createWalletStore is the exact { subscribe, getSnapshot } pair that
// `@nightfleet/wallet/react` hands to useSyncExternalStore. React requires
// getSnapshot to be referentially stable between real changes, or it loops -
// so that property is tested here rather than in a renderer.
import { describe, it, expect } from 'vitest';
import { createLaceConnector, createWalletStore, EMPTY_SNAPSHOT } from '../src/connector.js';
import { makeLaceV4, makeWindow, emptyWindow } from './mock-provider.js';

const connector = (win, opts = {}) => createLaceConnector({
  window: win, watchIntervalMs: 0, timeoutMs: 1_000, ...opts,
});

describe('createWalletStore', () => {
  it('exposes the useSyncExternalStore triple', () => {
    const store = createWalletStore(connector(emptyWindow()));
    expect(typeof store.subscribe).toBe('function');
    expect(typeof store.getSnapshot).toBe('function');
    expect(store.getServerSnapshot()).toBe(EMPTY_SNAPSHOT);
    expect(Object.isFrozen(store)).toBe(true);
  });

  it('returns the SAME snapshot object while nothing changes', () => {
    const c = connector(makeWindow(makeLaceV4()));
    const store = createWalletStore(c);
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
    c.detect();
    const b = store.getSnapshot();
    expect(b).not.toBe(a); // a real change
    c.detect();
    expect(store.getSnapshot()).toBe(b); // re-detect must not churn
  });

  it('notifies then yields the new snapshot', async () => {
    const c = connector(makeWindow(makeLaceV4()));
    const store = createWalletStore(c);
    const seen = [];
    const off = store.subscribe(() => seen.push(store.getSnapshot().status));
    await c.connect();
    expect(seen).toEqual(['available', 'connecting', 'connected']);
    off();
    c.disconnect();
    expect(seen).toHaveLength(3);
  });

  it('every snapshot is frozen, so nothing downstream can mutate shared state', async () => {
    const c = connector(makeWindow(makeLaceV4()));
    const s = await c.connect();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.wallet)).toBe(true);
    expect(Object.isFrozen(EMPTY_SNAPSHOT)).toBe(true);
  });

  it('the empty snapshot is a safe first render', () => {
    expect(EMPTY_SNAPSHOT).toMatchObject({
      status: 'unavailable', wallet: null, address: null,
      networkVerified: false, error: null,
    });
  });
});
