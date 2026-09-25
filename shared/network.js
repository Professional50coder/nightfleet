// @nightfleet/shared/network - network configuration for the Midnight deploy path.
//
// Pure data + validation. No side effects, no network calls, no filesystem
// access at import time: importing this module is always safe (the deploy CLI
// imports it before it knows whether Docker or a wallet exist).
//
// Values come from the Midnight Preprod network configuration,
// and every one of them is overridable by an environment variable so the same
// code drives midnight-local-dev, Preprod, and CI.
//
// Secrets never live here. The wallet seed is read straight from the
// environment by whoever needs to sign, is never copied into a config object,
// and is never printed - see WALLET_SEED_ENV / hasWalletSeed().

import { TOOLCHAIN } from './index.js';

/** Thrown for any invalid / unknown network configuration. */
export class NetworkConfigError extends Error {
  /** @param {string} message @param {string[]} [problems] */
  constructor(message, problems = []) {
    super(message);
    this.name = 'NetworkConfigError';
    this.problems = problems;
  }
}

/** Networks this project deploys to. Mainnet is explicitly out of scope. */
export const NETWORK_NAMES = Object.freeze(['local', 'preprod']);

/** Preprod is the target of the deploy path; `local` is the midnight-local-dev stack. */
export const DEFAULT_NETWORK = 'preprod';

/** The proof server is local Docker on every network. */
export const DEFAULT_PROOF_SERVER_URL = 'http://localhost:6300';

/**
 * Version pins for the whole Midnight stack. The Compact half is owned by
 * TOOLCHAIN in ./index.js (single source of truth); the rest is the known-good
 * support-matrix line from the Midnight docs:
 * https://docs.midnight.network/relnotes/support-matrix
 */
export const PINNED_VERSIONS = Object.freeze({
  ...TOOLCHAIN,
  midnightJs: '4.1.1',
  ledgerV8: '8.1.0',
  proofServerImage: 'midnightntwrk/proof-server',
  // Pin the proof-server Docker tag to your ledger/prover
  // version." Not yet confirmed against a running server - deliberately null so
  // the deploy CLI warns instead of silently implying :latest is fine.
  proofServerTag: null,
});

/**
 * Environment variables that override the presets below. Names are stable; the
 * CLI and the README both quote this map so they cannot drift.
 */
export const ENV_VARS = Object.freeze({
  network: 'NIGHTFLEET_NETWORK',
  networkId: 'NIGHTFLEET_NETWORK_ID',
  node: 'NIGHTFLEET_NODE_URL',
  indexer: 'NIGHTFLEET_INDEXER_URL',
  indexerWs: 'NIGHTFLEET_INDEXER_WS_URL',
  proofServer: 'NIGHTFLEET_PROOF_SERVER_URL',
  explorer: 'NIGHTFLEET_EXPLORER_URL',
});

/** Secret. Read at the point of use, never stored in a config object, never logged. */
export const WALLET_SEED_ENV = 'NIGHTFLEET_WALLET_SEED';

/** Endpoint presets. Schemes added; the docs list bare hosts. */
export const NETWORK_PRESETS = Object.freeze({
  local: Object.freeze({
    name: 'local',
    networkId: 'undeployed',
    node: 'http://localhost:9944',
    indexer: 'http://localhost:8088/api/v4/graphql',
    indexerWs: 'ws://localhost:8088/api/v4/graphql',
    proofServer: DEFAULT_PROOF_SERVER_URL,
    faucet: null, // midnight-local-dev ships a pre-funded genesis wallet
    explorer: null,
  }),
  preprod: Object.freeze({
    name: 'preprod',
    networkId: 'preprod',
    node: 'https://rpc.preprod.midnight.network',
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    proofServer: DEFAULT_PROOF_SERVER_URL,
    faucet: 'https://midnight-tmnight-preprod.nethermind.dev/',
    // No confirmed Preprod explorer base URL yet; set NIGHTFLEET_EXPLORER_URL
    // to switch on the addressUrl()/txUrl() helpers.
    explorer: null,
  }),
});

/** @returns {string[]} the network names this module knows about */
export function listNetworks() {
  return [...NETWORK_NAMES];
}

function isUrlWithScheme(value, schemes) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return schemes.includes(url.protocol);
}

/**
 * Validate a resolved network config without throwing.
 * @param {object} config
 * @returns {string[]} problems; empty means valid
 */
export function collectConfigProblems(config) {
  if (!config || typeof config !== 'object') return ['config must be an object'];
  const problems = [];

  if (!NETWORK_NAMES.includes(config.name)) {
    problems.push(`name must be one of ${NETWORK_NAMES.join(', ')}; received ${JSON.stringify(config.name)}`);
  }
  if (typeof config.networkId !== 'string' || config.networkId.trim() === '') {
    problems.push(`networkId must be a non-empty string (set ${ENV_VARS.networkId} to override)`);
  } else if (/^main(net)?$/i.test(config.networkId.trim())) {
    // mainnet and real-money wagering are out of scope.
    problems.push('networkId "mainnet" is out of scope for NightFleet; Preprod only');
  }

  const urlChecks = [
    ['node', ['http:', 'https:'], ENV_VARS.node],
    ['indexer', ['http:', 'https:'], ENV_VARS.indexer],
    ['indexerWs', ['ws:', 'wss:'], ENV_VARS.indexerWs],
    ['proofServer', ['http:', 'https:'], ENV_VARS.proofServer],
  ];
  for (const [key, schemes, envVar] of urlChecks) {
    if (!isUrlWithScheme(config[key], schemes)) {
      problems.push(
        `${key} must be a ${schemes.map((s) => s.replace(':', '')).join('/')} URL ` +
        `(set ${envVar} to override); received ${JSON.stringify(config[key])}`,
      );
    }
  }
  for (const key of ['faucet', 'explorer']) {
    if (config[key] != null && !isUrlWithScheme(config[key], ['http:', 'https:'])) {
      problems.push(`${key} must be an http/https URL or null; received ${JSON.stringify(config[key])}`);
    }
  }
  return problems;
}

/**
 * @param {object} config
 * @returns {object} the same config, when valid
 * @throws {NetworkConfigError}
 */
export function assertValidNetworkConfig(config) {
  const problems = collectConfigProblems(config);
  if (problems.length > 0) {
    throw new NetworkConfigError(
      `invalid network configuration:\n  - ${problems.join('\n  - ')}`,
      problems,
    );
  }
  return config;
}

/**
 * Resolve a network config: preset -> environment overrides -> validation.
 *
 * @param {string} [name] network name; falls back to $NIGHTFLEET_NETWORK, then DEFAULT_NETWORK
 * @param {Record<string, string|undefined>} [env] environment (injected; defaults to {} so this stays pure)
 * @returns {Readonly<object>} frozen, validated config
 * @throws {NetworkConfigError}
 */
export function resolveNetwork(name, env = {}) {
  const chosen = name ?? env[ENV_VARS.network] ?? DEFAULT_NETWORK;
  if (typeof chosen !== 'string' || !Object.hasOwn(NETWORK_PRESETS, chosen)) {
    throw new NetworkConfigError(
      `unknown network ${JSON.stringify(chosen)}; expected one of ${NETWORK_NAMES.join(', ')} ` +
      `(via --network or ${ENV_VARS.network})`,
    );
  }

  const preset = NETWORK_PRESETS[chosen];
  const overridden = [];
  const pick = (key) => {
    const raw = env[ENV_VARS[key]];
    if (typeof raw !== 'string' || raw.trim() === '') return preset[key];
    overridden.push(key);
    return raw.trim();
  };

  const config = {
    name: preset.name,
    networkId: pick('networkId'),
    node: pick('node'),
    indexer: pick('indexer'),
    indexerWs: pick('indexerWs'),
    proofServer: pick('proofServer'),
    faucet: preset.faucet,
    explorer: pick('explorer') ?? null,
    overridden: Object.freeze(overridden),
    versions: PINNED_VERSIONS,
  };

  assertValidNetworkConfig(config);
  return Object.freeze(config);
}

/**
 * Is a wallet seed available to sign with? Presence only - the value is never
 * returned, copied or logged by this module.
 * @param {Record<string, string|undefined>} [env]
 */
export function hasWalletSeed(env = {}) {
  const raw = env[WALLET_SEED_ENV];
  return typeof raw === 'string' && raw.trim() !== '';
}

/** Explorer deep link for a contract address, or null when no explorer is configured. */
export function addressUrl(config, address) {
  if (!config?.explorer || typeof address !== 'string' || address.trim() === '') return null;
  return `${config.explorer.replace(/\/+$/, '')}/address/${encodeURIComponent(address.trim())}`;
}

/** Explorer deep link for a transaction, or null when no explorer is configured. */
export function txUrl(config, txId) {
  if (!config?.explorer || typeof txId !== 'string' || txId.trim() === '') return null;
  return `${config.explorer.replace(/\/+$/, '')}/tx/${encodeURIComponent(txId.trim())}`;
}

/**
 * Human-readable, secret-free description of a config, for CLI output.
 * @returns {Array<[string, string]>} label/value pairs
 */
export function describeNetwork(config) {
  const rows = [
    ['network', config.name],
    ['network id', config.networkId],
    ['node', config.node],
    ['indexer (http)', config.indexer],
    ['indexer (ws)', config.indexerWs],
    ['proof server', config.proofServer],
  ];
  if (config.faucet) rows.push(['faucet', config.faucet]);
  rows.push(['explorer', config.explorer ?? 'not configured']);
  rows.push(['overrides', config.overridden?.length ? config.overridden.join(', ') : 'none (all defaults)']);
  return rows;
}
