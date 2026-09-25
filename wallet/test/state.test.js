// The state machine is the contract with the UI: every legal edge is listed
// here so a future change to TRANSITIONS cannot quietly break a render path.
import { describe, it, expect } from 'vitest';
import {
  WalletStatus, WALLET_STATUSES, TRANSITIONS,
  canTransition, assertTransition, isWalletStatus,
} from '../src/state.js';

const LEGAL = [
  ['unavailable', 'available'],
  ['unavailable', 'error'],
  ['available', 'connecting'],
  ['available', 'unavailable'],
  ['available', 'error'],
  ['connecting', 'connected'],
  ['connecting', 'error'],
  ['connecting', 'available'],
  ['connecting', 'unavailable'],
  ['connected', 'available'],
  ['connected', 'error'],
  ['connected', 'unavailable'],
  ['error', 'connecting'],
  ['error', 'available'],
  ['error', 'unavailable'],
];

describe('wallet state machine', () => {
  it('has exactly the five documented states', () => {
    expect([...WALLET_STATUSES].sort()).toEqual(
      ['available', 'connected', 'connecting', 'error', 'unavailable'],
    );
    for (const s of WALLET_STATUSES) expect(isWalletStatus(s)).toBe(true);
    expect(isWalletStatus('idle')).toBe(false);
  });

  it('allows every documented edge and nothing else', () => {
    const legal = new Set(LEGAL.map(([a, b]) => `${a}->${b}`));
    for (const from of WALLET_STATUSES) {
      for (const to of WALLET_STATUSES) {
        if (from === to) continue;
        expect(canTransition(from, to), `${from}->${to}`).toBe(legal.has(`${from}->${to}`));
      }
    }
  });

  it('treats a same-state update as legal (payload may still change)', () => {
    for (const s of WALLET_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it('never allows unavailable -> connected without passing through connecting', () => {
    expect(canTransition(WalletStatus.UNAVAILABLE, WalletStatus.CONNECTED)).toBe(false);
    expect(canTransition(WalletStatus.AVAILABLE, WalletStatus.CONNECTED)).toBe(false);
    expect(canTransition(WalletStatus.ERROR, WalletStatus.CONNECTED)).toBe(false);
  });

  it('throws on an illegal transition', () => {
    expect(() => assertTransition('unavailable', 'connected'))
      .toThrow(/illegal wallet state transition/);
    expect(() => assertTransition('connected', 'connecting'))
      .toThrow(/illegal wallet state transition/);
  });

  it('rejects unknown states', () => {
    expect(canTransition('idle', 'connected')).toBe(false);
    expect(canTransition('available', 'pending')).toBe(false);
  });

  it('exposes a frozen transition table', () => {
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(TRANSITIONS.connected)).toBe(true);
  });
});
