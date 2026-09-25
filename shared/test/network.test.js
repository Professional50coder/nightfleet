// @nightfleet/shared/network tests: preset fidelity to docs/07, environment
// overrides, validation failure modes, explorer helpers, and the invariant that
// the wallet seed never leaks into a config object or a printable description.
import { describe, it, expect } from 'vitest';
import { TOOLCHAIN } from '../index.js';
import {
  NETWORK_NAMES, DEFAULT_NETWORK, DEFAULT_PROOF_SERVER_URL, PINNED_VERSIONS,
  ENV_VARS, WALLET_SEED_ENV, NETWORK_PRESETS, NetworkConfigError,
  listNetworks, resolveNetwork, collectConfigProblems, assertValidNetworkConfig,
  hasWalletSeed, addressUrl, txUrl, describeNetwork,
} from '../network.js';

describe('presets', () => {
  it('knows exactly the two in-scope networks', () => {
    expect(listNetworks()).toEqual(['local', 'preprod']);
    expect(NETWORK_NAMES).toEqual(Object.keys(NETWORK_PRESETS));
    expect(DEFAULT_NETWORK).toBe('preprod');
  });

  it('matches the endpoints in docs/07 section 5', () => {
    expect(NETWORK_PRESETS.local.networkId).toBe('undeployed');
    expect(NETWORK_PRESETS.local.node).toContain('localhost:9944');
    expect(NETWORK_PRESETS.local.indexer).toContain('localhost:8088/api/v4/graphql');
    expect(NETWORK_PRESETS.preprod.networkId).toBe('preprod');
    expect(NETWORK_PRESETS.preprod.node).toContain('rpc.preprod.midnight.network');
    expect(NETWORK_PRESETS.preprod.indexer).toContain('indexer.preprod.midnight.network/api/v4/graphql');
    // the proof server is local Docker on every network
    for (const preset of Object.values(NETWORK_PRESETS)) {
      expect(preset.proofServer).toBe(DEFAULT_PROOF_SERVER_URL);
      expect(preset.proofServer).toContain(':6300');
    }
  });

  it('presets are frozen so a caller cannot mutate shared state', () => {
    expect(Object.isFrozen(NETWORK_PRESETS)).toBe(true);
    expect(Object.isFrozen(NETWORK_PRESETS.preprod)).toBe(true);
    expect(() => { NETWORK_PRESETS.preprod.node = 'http://evil.example'; }).toThrow();
  });

  it('carries the Compact pins from TOOLCHAIN plus the midnight.js support line', () => {
    expect(PINNED_VERSIONS.compactCompiler).toBe(TOOLCHAIN.compactCompiler);
    expect(PINNED_VERSIONS.compactRuntime).toBe(TOOLCHAIN.compactRuntime);
    expect(PINNED_VERSIONS.midnightJs).toBe('4.1.1');
    expect(PINNED_VERSIONS.ledgerV8).toBe('8.1.0');
    // deliberately unpinned until confirmed against a running proof server
    expect(PINNED_VERSIONS.proofServerTag).toBeNull();
  });
});

describe('resolveNetwork', () => {
  it('defaults to preprod and returns a frozen, validated config', () => {
    const cfg = resolveNetwork();
    expect(cfg.name).toBe('preprod');
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(collectConfigProblems(cfg)).toEqual([]);
    expect(cfg.overridden).toEqual([]);
    expect(cfg.versions).toBe(PINNED_VERSIONS);
  });

  it('resolves local from an explicit name', () => {
    const cfg = resolveNetwork('local');
    expect(cfg.networkId).toBe('undeployed');
    expect(cfg.indexerWs.startsWith('ws://')).toBe(true);
  });

  it('falls back to $NIGHTFLEET_NETWORK when no name is given', () => {
    expect(resolveNetwork(undefined, { [ENV_VARS.network]: 'local' }).name).toBe('local');
  });

  it('an explicit name wins over $NIGHTFLEET_NETWORK', () => {
    expect(resolveNetwork('preprod', { [ENV_VARS.network]: 'local' }).name).toBe('preprod');
  });

  it('rejects an unknown network by name or by env', () => {
    expect(() => resolveNetwork('mainnet')).toThrow(NetworkConfigError);
    expect(() => resolveNetwork('mainnet')).toThrow(/unknown network "mainnet".*local, preprod/s);
    expect(() => resolveNetwork(undefined, { [ENV_VARS.network]: 'testnet' })).toThrow(/unknown network/);
  });

  it('is pure: it reads only the injected env, never process.env', () => {
    const key = ENV_VARS.node;
    const saved = process.env[key];
    process.env[key] = 'http://should-be-ignored.example';
    try {
      expect(resolveNetwork('preprod').node).toBe(NETWORK_PRESETS.preprod.node);
    } finally {
      if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    }
  });
});

describe('environment overrides', () => {
  it('overrides every endpoint and records which keys were overridden', () => {
    const env = {
      [ENV_VARS.networkId]: 'preprod-2',
      [ENV_VARS.node]: 'http://localhost:19944',
      [ENV_VARS.indexer]: 'http://localhost:18088/api/v4/graphql',
      [ENV_VARS.indexerWs]: 'ws://localhost:18088/api/v4/graphql',
      [ENV_VARS.proofServer]: 'http://localhost:16300',
      [ENV_VARS.explorer]: 'https://explorer.example/',
    };
    const cfg = resolveNetwork('preprod', env);
    expect(cfg.networkId).toBe('preprod-2');
    expect(cfg.node).toBe('http://localhost:19944');
    expect(cfg.indexer).toBe('http://localhost:18088/api/v4/graphql');
    expect(cfg.indexerWs).toBe('ws://localhost:18088/api/v4/graphql');
    expect(cfg.proofServer).toBe('http://localhost:16300');
    expect(cfg.explorer).toBe('https://explorer.example/');
    expect([...cfg.overridden].sort()).toEqual(
      ['explorer', 'indexer', 'indexerWs', 'networkId', 'node', 'proofServer'],
    );
  });

  it('trims values and ignores empty / whitespace-only overrides', () => {
    const cfg = resolveNetwork('local', {
      [ENV_VARS.node]: '  http://localhost:29944  ',
      [ENV_VARS.indexer]: '   ',
      [ENV_VARS.proofServer]: '',
    });
    expect(cfg.node).toBe('http://localhost:29944');
    expect(cfg.indexer).toBe(NETWORK_PRESETS.local.indexer);
    expect(cfg.proofServer).toBe(DEFAULT_PROOF_SERVER_URL);
    expect(cfg.overridden).toEqual(['node']);
  });

  it('validates overrides: a non-URL node is rejected with the env var to fix', () => {
    expect(() => resolveNetwork('preprod', { [ENV_VARS.node]: 'localhost:9944' }))
      .toThrow(new RegExp(ENV_VARS.node));
  });

  it('rejects an http url where a websocket url is required', () => {
    expect(() => resolveNetwork('preprod', { [ENV_VARS.indexerWs]: 'https://indexer.example/graphql' }))
      .toThrow(/indexerWs must be a ws\/wss URL/);
  });

  it('refuses a mainnet network id - out of scope (docs/PLAN.md section 4)', () => {
    expect(() => resolveNetwork('preprod', { [ENV_VARS.networkId]: 'mainnet' }))
      .toThrow(/out of scope/);
    expect(() => resolveNetwork('preprod', { [ENV_VARS.networkId]: 'MainNet' }))
      .toThrow(/out of scope/);
  });
});

describe('validation', () => {
  const valid = () => ({ ...resolveNetwork('preprod') });

  it('accepts a good config and returns it', () => {
    const cfg = valid();
    expect(assertValidNetworkConfig(cfg)).toBe(cfg);
  });

  it('reports a non-object config', () => {
    expect(collectConfigProblems(null)).toEqual(['config must be an object']);
    expect(collectConfigProblems('preprod')).toEqual(['config must be an object']);
  });

  it('aggregates every problem rather than failing on the first', () => {
    const problems = collectConfigProblems({
      name: 'nowhere', networkId: '', node: 'nope', indexer: 'nope',
      indexerWs: 'nope', proofServer: 'nope', faucet: 'nope', explorer: 'nope',
    });
    expect(problems.length).toBe(8);
    const err = (() => {
      try { assertValidNetworkConfig({ name: 'nowhere', networkId: '' }); return null; } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(NetworkConfigError);
    expect(err.problems.length).toBeGreaterThan(1);
    expect(err.message).toContain('invalid network configuration');
  });

  it('allows null faucet/explorer but not a non-URL string', () => {
    expect(collectConfigProblems({ ...valid(), faucet: null, explorer: null })).toEqual([]);
    expect(collectConfigProblems({ ...valid(), explorer: 'explorer.example' }))
      .toEqual([expect.stringContaining('explorer must be an http/https URL')]);
  });
});

describe('wallet seed handling', () => {
  it('detects presence only', () => {
    expect(hasWalletSeed({})).toBe(false);
    expect(hasWalletSeed({ [WALLET_SEED_ENV]: '' })).toBe(false);
    expect(hasWalletSeed({ [WALLET_SEED_ENV]: '   ' })).toBe(false);
    expect(hasWalletSeed({ [WALLET_SEED_ENV]: 'abc' })).toBe(true);
  });

  it('never copies the seed into the resolved config or its description', () => {
    const secret = 'seed-value-that-must-never-appear-anywhere';
    const env = { [WALLET_SEED_ENV]: secret, [ENV_VARS.network]: 'preprod' };
    const cfg = resolveNetwork(undefined, env);
    expect(JSON.stringify(cfg)).not.toContain(secret);
    expect(JSON.stringify(describeNetwork(cfg))).not.toContain(secret);
    expect(Object.values(cfg)).not.toContain(secret);
  });
});

describe('explorer links', () => {
  const withExplorer = resolveNetwork('preprod', { [ENV_VARS.explorer]: 'https://explorer.example/' });

  it('returns null when no explorer is configured', () => {
    const cfg = resolveNetwork('preprod');
    expect(cfg.explorer).toBeNull();
    expect(addressUrl(cfg, '0200abcd')).toBeNull();
    expect(txUrl(cfg, 'deadbeef')).toBeNull();
  });

  it('builds address and tx links, trimming the trailing slash', () => {
    expect(addressUrl(withExplorer, '0200abcd')).toBe('https://explorer.example/address/0200abcd');
    expect(txUrl(withExplorer, ' deadbeef ')).toBe('https://explorer.example/tx/deadbeef');
  });

  it('returns null for a missing or empty identifier', () => {
    expect(addressUrl(withExplorer, '')).toBeNull();
    expect(txUrl(withExplorer, undefined)).toBeNull();
    expect(addressUrl(undefined, 'abc')).toBeNull();
  });

  it('encodes identifiers so they cannot break out of the path', () => {
    expect(addressUrl(withExplorer, 'a/../b')).toBe('https://explorer.example/address/a%2F..%2Fb');
  });
});

describe('describeNetwork', () => {
  it('renders every endpoint plus the override summary', () => {
    const rows = Object.fromEntries(describeNetwork(resolveNetwork('preprod')));
    expect(rows.network).toBe('preprod');
    expect(rows['network id']).toBe('preprod');
    expect(rows['proof server']).toBe(DEFAULT_PROOF_SERVER_URL);
    expect(rows.explorer).toBe('not configured');
    expect(rows.overrides).toMatch(/none/);
    expect(rows.faucet).toContain('nethermind.dev');
  });

  it('names the overridden keys and omits the faucet on local', () => {
    const rows = Object.fromEntries(
      describeNetwork(resolveNetwork('local', { [ENV_VARS.node]: 'http://localhost:1' })),
    );
    expect(rows.overrides).toBe('node');
    expect(rows.faucet).toBeUndefined();
  });
});
