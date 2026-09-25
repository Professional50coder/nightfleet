// Detection and the API-version gate: "extension not installed" and
// "connector API version mismatch" must be distinguishable, not both "failed".
import { describe, it, expect } from 'vitest';
import {
  detectWallets, pickWallet, parseApiMajor, detectFlavor, assertUsable,
  SUPPORTED_API_MAJORS, LACE_HINTS,
} from '../src/detect.js';
import { WalletErrorCode } from '../src/errors.js';
import { makeLaceV4, makeLaceV3, makeWindow, emptyWindow } from './mock-provider.js';

describe('parseApiMajor', () => {
  it('reads the major of a semver string', () => {
    expect(parseApiMajor('4.0.1')).toBe(4);
    expect(parseApiMajor('3.0.0')).toBe(3);
    expect(parseApiMajor('10.2.3-beta.1')).toBe(10);
  });

  it('returns null for anything that is not semver', () => {
    for (const v of ['', 'v4', '4', '4.0', null, undefined, 42, {}]) {
      expect(parseApiMajor(v)).toBeNull();
    }
  });
});

describe('detectFlavor', () => {
  it('picks v4 from connect() and v3 from enable()', () => {
    expect(detectFlavor({ connect: () => {} })).toBe('v4');
    expect(detectFlavor({ enable: () => {} })).toBe('v3');
    expect(detectFlavor({ connect: () => {}, enable: () => {} })).toBe('v4');
  });

  it('returns null for a non-connector object', () => {
    expect(detectFlavor({ name: 'not a wallet' })).toBeNull();
    expect(detectFlavor(null)).toBeNull();
    expect(detectFlavor('mnLace')).toBeNull();
  });
});

describe('detectWallets', () => {
  it('finds nothing when the extension is not installed', () => {
    expect(detectWallets(emptyWindow())).toEqual([]);
    expect(detectWallets({ midnight: {} })).toEqual([]);
    expect(detectWallets(undefined)).toEqual([]);
    expect(detectWallets({ midnight: 'nope' })).toEqual([]);
  });

  it('describes an injected v4 wallet', () => {
    const lace = makeLaceV4();
    const [w] = detectWallets(makeWindow(lace));
    expect(w).toMatchObject({
      key: 'mnLace', name: 'Lace', rdns: 'io.lace',
      apiVersion: '4.0.1', apiMajor: 4, flavor: 'v4', supported: true, isLace: true,
    });
  });

  it('describes an injected v3 wallet as supported legacy', () => {
    const [w] = detectWallets(makeWindow(makeLaceV3()));
    expect(w).toMatchObject({ apiMajor: 3, flavor: 'v3', supported: true });
    expect(w.rdns).toBe('');
  });

  it('marks an unknown major unsupported instead of throwing', () => {
    const [w] = detectWallets(makeWindow(makeLaceV4({ apiVersion: '99.0.0' })));
    expect(w.apiMajor).toBe(99);
    expect(w.supported).toBe(false);
  });

  it('marks a garbage injection unsupported instead of throwing', () => {
    const win = { midnight: { junk: { name: 'junk', apiVersion: '4.0.1' } } };
    const [w] = detectWallets(win);
    expect(w.flavor).toBeNull();
    expect(w.supported).toBe(false);
  });

  it('survives a property getter that throws', () => {
    const win = { midnight: {} };
    Object.defineProperty(win.midnight, 'hostile', {
      enumerable: true,
      get() { throw new Error('boom'); },
    });
    expect(() => detectWallets(win)).not.toThrow();
    expect(detectWallets(win)).toEqual([]);
  });

  it('recognises Lace by key or rdns', () => {
    expect(LACE_HINTS.length).toBeGreaterThan(0);
    const byRdns = makeLaceV4({ key: 'wallet0', rdns: 'io.lace' });
    const other = makeLaceV4({ key: 'someWallet', rdns: 'com.example.wallet' });
    const found = detectWallets(makeWindow(byRdns, other));
    expect(found.find((w) => w.key === 'wallet0').isLace).toBe(true);
    expect(found.find((w) => w.key === 'someWallet').isLace).toBe(false);
  });
});

describe('pickWallet', () => {
  it('returns null when nothing is injected', () => {
    expect(pickWallet([])).toBeNull();
    expect(pickWallet(null)).toBeNull();
  });

  it('prefers a supported wallet over an unsupported one', () => {
    const bad = makeLaceV4({ key: 'oldWallet', rdns: 'com.other', apiVersion: '99.0.0' });
    const good = makeLaceV4({ key: 'newWallet', rdns: 'com.other' });
    const picked = pickWallet(detectWallets(makeWindow(bad, good)));
    expect(picked.key).toBe('newWallet');
  });

  it('prefers Lace when several supported wallets are present', () => {
    const other = makeLaceV4({ key: 'aaaOther', rdns: 'com.example.wallet' });
    const lace = makeLaceV4({ key: 'zzzLace', rdns: 'io.lace' });
    expect(pickWallet(detectWallets(makeWindow(other, lace))).key).toBe('zzzLace');
  });

  it('prefers API major 4 over the legacy 3', () => {
    const v3 = makeLaceV3({ key: 'legacy' });
    const v4 = makeLaceV4({ key: 'modern', rdns: 'com.other' });
    expect(pickWallet(detectWallets(makeWindow(v3, v4))).key).toBe('modern');
  });

  it('honours an explicit walletKey pin, and returns null when it is absent', () => {
    const wallets = detectWallets(makeWindow(makeLaceV4(), makeLaceV4({ key: 'other', rdns: 'x' })));
    expect(pickWallet(wallets, { walletKey: 'other' }).key).toBe('other');
    expect(pickWallet(wallets, { walletKey: 'ghost' })).toBeNull();
  });
});

describe('assertUsable', () => {
  it('accepts a supported wallet', () => {
    const [w] = detectWallets(makeWindow(makeLaceV4()));
    expect(assertUsable(w)).toBe(w);
    expect(SUPPORTED_API_MAJORS).toContain(4);
  });

  it('reports NO_PROVIDER for nothing at all', () => {
    expect(() => assertUsable(null)).toThrowError(
      expect.objectContaining({ code: WalletErrorCode.NO_PROVIDER }),
    );
  });

  it('reports UNSUPPORTED_API_VERSION for a future major', () => {
    const [w] = detectWallets(makeWindow(makeLaceV4({ apiVersion: '99.0.0' })));
    expect(() => assertUsable(w)).toThrowError(
      expect.objectContaining({ code: WalletErrorCode.UNSUPPORTED_API_VERSION }),
    );
  });

  it('reports UNSUPPORTED_API_VERSION for a non-semver apiVersion', () => {
    const [w] = detectWallets(makeWindow(makeLaceV4({ apiVersion: 'latest' })));
    expect(() => assertUsable(w)).toThrowError(
      expect.objectContaining({ code: WalletErrorCode.UNSUPPORTED_API_VERSION }),
    );
  });

  it('reports UNSUPPORTED_API_VERSION when neither connect() nor enable() exists', () => {
    const [w] = detectWallets({ midnight: { junk: { apiVersion: '4.0.1' } } });
    expect(() => assertUsable(w)).toThrowError(
      expect.objectContaining({ code: WalletErrorCode.UNSUPPORTED_API_VERSION }),
    );
  });
});
