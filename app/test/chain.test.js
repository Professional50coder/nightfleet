import { describe, expect, it } from 'vitest';
import { encodeState, decodeState } from '../src/chain/codec.js';
import { BrowserPrivateStateProvider } from '../src/chain/private-state.js';
import { squadLinkFor, parseSquadLink } from '../src/chain/squad.js';
import { findWallets, connectWallet } from '../src/chain/lace.js';

const ADDR = '15bd24d16878cfc5ee2537223ddd41a13f0ca451c1d64b796a4643b87c94bab6';

describe('chain codec', () => {
  it('round-trips bigint and Uint8Array through JSON', () => {
    const state = { sk: new Uint8Array([1, 2, 255]), salt: new Uint8Array(32), board: [0n, 1n], hits: 7n };
    const back = decodeState(encodeState(state));
    expect(back.sk).toBeInstanceOf(Uint8Array);
    expect(Array.from(back.sk)).toEqual([1, 2, 255]);
    expect(back.board).toEqual([0n, 1n]);
    expect(back.hits).toBe(7n);
  });

  it('decodes null/empty storage to null', () => {
    expect(decodeState(null)).toBeNull();
  });
});

describe('BrowserPrivateStateProvider', () => {
  const fresh = () => new BrowserPrivateStateProvider(new MapStorage());

  it('requires setContractAddress before any state operation', async () => {
    const psp = fresh();
    await expect(psp.get('nightfleet')).rejects.toThrow(/setContractAddress/);
  });

  it('scopes state per contract address', async () => {
    const psp = fresh();
    psp.setContractAddress(ADDR);
    await psp.set('nightfleet', { sk: new Uint8Array([9]) });
    const other = 'a'.repeat(64);
    psp.setContractAddress(other);
    expect(await psp.get('nightfleet')).toBeNull();
    psp.setContractAddress(ADDR);
    expect((await psp.get('nightfleet')).sk).toEqual(new Uint8Array([9]));
  });

  it('stores and clears signing keys', async () => {
    const psp = fresh();
    await psp.setSigningKey(ADDR, 'signing-key');
    expect(await psp.getSigningKey(ADDR)).toBe('signing-key');
    await psp.removeSigningKey(ADDR);
    expect(await psp.getSigningKey(ADDR)).toBeNull();
  });
});

describe('squad links', () => {
  it('builds and parses a link round-trip', () => {
    const link = squadLinkFor(ADDR, 'https://nightfleet.example/play');
    expect(link).toBe(`https://nightfleet.example/play#/game/${ADDR}`);
    expect(parseSquadLink(link)).toBe(ADDR);
  });

  it('accepts a bare hash or bare address, rejects junk', () => {
    expect(parseSquadLink(`#/game/${ADDR}`)).toBe(ADDR);
    expect(parseSquadLink(ADDR)).toBe(ADDR);
    expect(parseSquadLink('https://nightfleet.example/#/game/not-an-address')).toBeNull();
    expect(parseSquadLink('')).toBeNull();
    expect(() => squadLinkFor('0x123')).toThrow(/contract address/);
  });
});

describe('lace discovery', () => {
  it('finds injected wallets by shape, not by key name', () => {
    const win = { midnight: { '9f3c-uuid': { connect: async () => ({}) }, noise: 42 } };
    expect(findWallets(win)).toHaveLength(1);
  });

  it('connects with the requested network and honours a preferred rdns', async () => {
    const calls = [];
    const mk = (rdns) => ({ rdns, connect: async (net) => (calls.push([rdns, net]), { rdns }) });
    const win = { midnight: { a: mk('io.lace'), b: mk('com.other') } };
    const { api } = await connectWallet({ networkId: 'preprod', prefer: 'com.other', win });
    expect(api.rdns).toBe('com.other');
    expect(calls).toEqual([['com.other', 'preprod']]);
  });

  it('says what to do when no wallet is injected', async () => {
    await expect(connectWallet({ win: { midnight: {} } })).rejects.toThrow(/Lace/);
  });
});

/** Minimal Storage stand-in (jsdom's localStorage exists, but keep it explicit). */
class MapStorage {
  #map = new Map();
  get length() { return this.#map.size; }
  key(i) { return [...this.#map.keys()][i] ?? null; }
  getItem(k) { return this.#map.has(k) ? this.#map.get(k) : null; }
  setItem(k, v) { this.#map.set(k, String(v)); }
  removeItem(k) { this.#map.delete(k); }
}
