// The Preprod guard: Preprod only, never mainnet.
// Every ambiguous case must fail closed - a silent wrong-network connection is
// the failure mode this whole module exists to prevent.
import { describe, it, expect } from 'vitest';
import {
  NetworkId, DEFAULT_EXPECTED_NETWORK_ID, ALLOWED_EXPECTED_NETWORK_IDS,
  isMainnetId, isPreprodId, assertAllowedTarget, checkNetwork, inferNetworkIdFromUris,
} from '../src/networks.js';

describe('target configuration', () => {
  it('defaults to preprod', () => {
    expect(DEFAULT_EXPECTED_NETWORK_ID).toBe('preprod');
    expect(ALLOWED_EXPECTED_NETWORK_IDS).not.toContain(NetworkId.MAINNET);
  });

  it('refuses to be configured for mainnet', () => {
    for (const id of ['mainnet', 'MainNet', 'main-net', 'main_net']) {
      expect(() => assertAllowedTarget(id)).toThrow(/refuses to target mainnet/);
    }
  });

  it('refuses an empty target', () => {
    expect(() => assertAllowedTarget('')).toThrow(/non-empty/);
    expect(() => assertAllowedTarget(undefined)).toThrow(/non-empty/);
  });

  it('accepts preprod, preview and undeployed', () => {
    for (const id of ALLOWED_EXPECTED_NETWORK_IDS) {
      expect(assertAllowedTarget(id)).toBe(id);
    }
  });
});

describe('isMainnetId / isPreprodId', () => {
  it('matches mainnet spellings', () => {
    for (const id of ['mainnet', 'MAINNET', ' main-net ', 'main_net']) {
      expect(isMainnetId(id)).toBe(true);
    }
    for (const id of ['preprod', 'preview', 'mainnetish', '', null]) {
      expect(isMainnetId(id)).toBe(false);
    }
  });

  it('matches preprod spellings', () => {
    for (const id of ['preprod', 'PreProd', 'pre-prod', 'pre_prod']) {
      expect(isPreprodId(id)).toBe(true);
    }
    expect(isPreprodId('preview')).toBe(false);
  });
});

describe('checkNetwork', () => {
  it('passes when the wallet is on the expected network', () => {
    expect(checkNetwork('preprod', 'preprod')).toEqual({ ok: true, networkId: 'preprod' });
    expect(checkNetwork(' PrePROD ', 'preprod')).toEqual({ ok: true, networkId: 'preprod' });
  });

  it('accepts the pre-prod spelling of preprod but nothing looser', () => {
    expect(checkNetwork('pre-prod', 'preprod').ok).toBe(true);
    expect(checkNetwork('preprod-2', 'preprod').ok).toBe(false);
  });

  it('flags mainnet with its own code, even if someone configured it as expected', () => {
    expect(checkNetwork('mainnet', 'preprod'))
      .toEqual({ ok: false, code: 'MAINNET_REFUSED', networkId: 'mainnet' });
    expect(checkNetwork('mainnet', 'mainnet').code).toBe('MAINNET_REFUSED');
  });

  it('flags any other mismatch as WRONG_NETWORK', () => {
    expect(checkNetwork('preview', 'preprod'))
      .toEqual({ ok: false, code: 'WRONG_NETWORK', networkId: 'preview' });
    expect(checkNetwork('undeployed', 'preprod').code).toBe('WRONG_NETWORK');
  });

  it('fails closed when the wallet reports nothing', () => {
    for (const reported of [null, undefined, '', '   ', 42]) {
      expect(checkNetwork(reported, 'preprod'))
        .toEqual({ ok: false, code: 'NETWORK_UNVERIFIED', networkId: null });
    }
  });
});

describe('inferNetworkIdFromUris', () => {
  it('reads preprod out of the configured service hosts', () => {
    expect(inferNetworkIdFromUris({
      indexerUri: 'https://indexer.preprod.midnight.network/api/v4/graphql',
      substrateNodeUri: 'wss://rpc.preprod.midnight.network',
    })).toBe('preprod');
  });

  it('reads mainnet first, so a mixed config never passes as preprod', () => {
    expect(inferNetworkIdFromUris({
      indexerUri: 'https://indexer.preprod.midnight.network',
      substrateNodeUri: 'wss://rpc.mainnet.midnight.network',
    })).toBe('mainnet');
  });

  it('reads preview and local', () => {
    expect(inferNetworkIdFromUris({ indexerUri: 'https://indexer.preview.midnight.network' }))
      .toBe('preview');
    expect(inferNetworkIdFromUris({ substrateNodeUri: 'ws://localhost:9944' }))
      .toBe('undeployed');
  });

  it('returns null rather than guessing', () => {
    expect(inferNetworkIdFromUris({})).toBeNull();
    expect(inferNetworkIdFromUris(null)).toBeNull();
    expect(inferNetworkIdFromUris({ indexerUri: 'https://example.com/graphql' })).toBeNull();
  });
});
