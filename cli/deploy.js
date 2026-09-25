// NOTE: deliberately no `#!/usr/bin/env node` here, unlike play.js. This module
// is imported by test/deploy.test.js, and Vite rejects a shebang in an IMPORTED
// module with "SyntaxError: Invalid or unexpected token". That fails the file at
// collection time, so vitest reports the suite as absent rather than failing -
// 40 tests silently not running. Invoke as `node deploy.js`, per the README.
// NightFleet deploy CLI - deploy the compiled contract to a Midnight network.
//
//   node deploy.js --dry-run                 # validate everything, touch nothing
//   node deploy.js --network preprod --confirm
//
// Design note: every external dependency (wallet, proof server, indexer, node)
// sits behind the injected DeployProvider interface below, and every side
// effect (filesystem, clock, stdout) is injected into runDeploy(). That is what
// lets the whole flow be exercised today - with no Docker, no wallet and no
// contract/managed/ - against fakes. See test/deploy.test.js.
//
// Secrets: the wallet seed is read from $NIGHTFLEET_WALLET_SEED at the point of
// use only. It is never copied into the config, the deployment record, or any
// log line. Nothing in this file may print it.

import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveNetwork, describeNetwork, hasWalletSeed, addressUrl, txUrl,
  NetworkConfigError, ENV_VARS, WALLET_SEED_ENV, NETWORK_NAMES, DEFAULT_NETWORK,
  PINNED_VERSIONS,
} from '../shared/network.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where `compact compile` puts its output (gitignored; regenerated on build). */
export const DEFAULT_MANAGED_DIR = path.resolve(HERE, '..', 'contract', 'managed');

/** Deployment record the README quotes. */
export const DEFAULT_OUT_FILE = path.resolve(HERE, '..', 'shared', 'deployments.json');

/** Process exit codes - distinct per failure mode so CI and tests can assert them. */
export const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  config: 2,
  artifacts: 3,
  wallet: 4,
  unconfirmed: 5,
  deploy: 6,
});

/** Thrown for CLI-level failures; `code` is one of EXIT. */
export class DeployError extends Error {
  constructor(message, code = EXIT.deploy) {
    super(message);
    this.name = 'DeployError';
    this.code = code;
  }
}

const USAGE = `nightfleet deploy - deploy the compiled contract to a Midnight network

usage:
  node deploy.js [--network <${NETWORK_NAMES.join('|')}>] [--dry-run | --confirm] [options]

options:
  --network <name>   target network (default: ${DEFAULT_NETWORK}, or $${ENV_VARS.network})
  --dry-run          validate config + artifacts and print the plan; deploys nothing
  --confirm          required to perform a real deploy (guards against accidents)
  --managed <dir>    compiled contract dir (default: contract/managed)
  --out <file>       deployment record to write (default: shared/deployments.json)
  --json             machine-readable output
  -h, --help         this text

environment:
  ${ENV_VARS.network}        network name
  ${ENV_VARS.networkId}     network id override
  ${ENV_VARS.node}       node RPC url
  ${ENV_VARS.indexer}    indexer GraphQL url (http)
  ${ENV_VARS.indexerWs} indexer GraphQL url (ws)
  ${ENV_VARS.proofServer} proof server url (local Docker, :6300)
  ${ENV_VARS.explorer}   explorer base url (enables address/tx links)
  ${WALLET_SEED_ENV}    deploy wallet seed - SECRET, never logged, never committed
`;

/**
 * @typedef {object} DeployRequest
 * @property {object} config   resolved network config (shared/network.js)
 * @property {object} artifacts result of inspectArtifacts()
 *
 * @typedef {object} DeployReceipt
 * @property {string} contractAddress
 * @property {string} txId
 * @property {number} [blockHeight]
 *
 * @typedef {object} DeployProvider
 * @property {string} name
 * @property {() => Promise<Record<string, {ok: boolean, detail?: string}>>} probe
 *           reachability of node / indexer / proof server / wallet
 * @property {(req: DeployRequest) => Promise<DeployReceipt>} deploy
 * @property {() => Promise<void>} [close]
 */

/* ------------------------------------------------------------------ args -- */

/** @returns {{network: string|undefined, dryRun: boolean, confirm: boolean, managedDir: string, outFile: string, json: boolean, help: boolean}} */
export function parseArgs(argv = []) {
  const args = {
    network: undefined,
    dryRun: false,
    confirm: false,
    managedDir: DEFAULT_MANAGED_DIR,
    outFile: DEFAULT_OUT_FILE,
    json: false,
    help: false,
  };
  const value = (flag, next) => {
    if (next === undefined || next.startsWith('--')) {
      throw new DeployError(`${flag} needs a value`, EXIT.usage);
    }
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--network': args.network = value(arg, argv[++i]); break;
      case '--managed': args.managedDir = value(arg, argv[++i]); break;
      case '--out': args.outFile = value(arg, argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
      case '--confirm': args.confirm = true; break;
      case '--json': args.json = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        throw new DeployError(`unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`, EXIT.usage);
    }
  }
  if (args.dryRun && args.confirm) {
    throw new DeployError('--dry-run and --confirm are mutually exclusive', EXIT.usage);
  }
  return args;
}

/* ------------------------------------------------------------- artifacts -- */

/** One of these must exist for the compiled contract module to be loadable. */
export const ARTIFACT_ENTRY_CANDIDATES = Object.freeze([
  path.join('contract', 'index.js'),
  path.join('contract', 'index.cjs'),
  path.join('contract', 'index.mjs'),
]);

/** These carry the proving/verifying material; missing means the deploy will fail. */
export const ARTIFACT_EXPECTED_DIRS = Object.freeze(['keys', 'zkir']);

/**
 * Inspect `contract/managed/` without importing anything. Never throws: the
 * caller decides whether absence is fatal (it is for a real deploy, it is only
 * reported for a dry run, because managed/ is gitignored and may be absent).
 *
 * @param {{managedDir?: string, fs?: typeof nodeFs}} [opts]
 */
export function inspectArtifacts({ managedDir = DEFAULT_MANAGED_DIR, fs = nodeFs } = {}) {
  const exists = (rel) => {
    try {
      return fs.existsSync(path.join(managedDir, rel));
    } catch {
      return false;
    }
  };
  let dirPresent = false;
  try {
    dirPresent = fs.existsSync(managedDir);
  } catch {
    dirPresent = false;
  }

  const entry = dirPresent ? ARTIFACT_ENTRY_CANDIDATES.find(exists) ?? null : null;
  const foundDirs = dirPresent ? ARTIFACT_EXPECTED_DIRS.filter(exists) : [];
  const missing = [];
  if (!dirPresent) missing.push(managedDir);
  else {
    if (!entry) missing.push(`${ARTIFACT_ENTRY_CANDIDATES.join(' | ')}`);
    for (const dir of ARTIFACT_EXPECTED_DIRS) if (!foundDirs.includes(dir)) missing.push(`${dir}/`);
  }

  return {
    managedDir,
    dirPresent,
    entry,
    entryPath: entry ? path.join(managedDir, entry) : null,
    foundDirs,
    missing,
    ok: missing.length === 0,
    compileHint: 'cd ../contract && npm run compile   # compact compile +'
      + `${PINNED_VERSIONS.compactCompiler} src/nightfleet.compact managed`,
  };
}

/* -------------------------------------------------------------- receipts -- */

/**
 * Guard the boundary: a provider is external code, so never trust its receipt.
 * @param {unknown} receipt @returns {DeployReceipt}
 */
export function assertDeployReceipt(receipt) {
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
  if (!receipt || typeof receipt !== 'object') {
    throw new DeployError(`provider returned ${receipt === undefined ? 'nothing' : JSON.stringify(receipt)} instead of a deploy receipt`);
  }
  if (!nonEmpty(receipt.contractAddress)) {
    throw new DeployError('provider returned no contractAddress; refusing to record a deployment');
  }
  if (!nonEmpty(receipt.txId)) {
    throw new DeployError('provider returned no txId; refusing to record a deployment');
  }
  if (receipt.blockHeight !== undefined
      && (!Number.isInteger(receipt.blockHeight) || receipt.blockHeight < 0)) {
    throw new DeployError(`provider returned an invalid blockHeight ${JSON.stringify(receipt.blockHeight)}`);
  }
  return {
    contractAddress: receipt.contractAddress.trim(),
    txId: receipt.txId.trim(),
    ...(receipt.blockHeight === undefined ? {} : { blockHeight: receipt.blockHeight }),
  };
}

/**
 * Build the record the README quotes. Contains no secrets by construction:
 * only endpoints, version pins, and the two public identifiers.
 */
export function buildDeploymentRecord({ config, receipt, deployedAt, provider }) {
  return {
    network: config.name,
    networkId: config.networkId,
    contractAddress: receipt.contractAddress,
    txId: receipt.txId,
    ...(receipt.blockHeight === undefined ? {} : { blockHeight: receipt.blockHeight }),
    deployedAt,
    provider,
    endpoints: { node: config.node, indexer: config.indexer, proofServer: config.proofServer },
    versions: config.versions ?? PINNED_VERSIONS,
    links: {
      address: addressUrl(config, receipt.contractAddress),
      tx: txUrl(config, receipt.txId),
    },
  };
}

/**
 * Merge a record into the deployments file, keyed by network, so a local and a
 * Preprod deployment can coexist. Returns the file contents written.
 */
export function writeDeploymentRecord({ outFile, record, fs = nodeFs, now = () => new Date().toISOString() }) {
  let existing = { deployments: {} };
  try {
    if (fs.existsSync(outFile)) {
      const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.deployments && typeof parsed.deployments === 'object') {
        existing = parsed;
      }
    }
  } catch {
    // Unreadable or corrupt file: start fresh rather than lose the new deploy.
    existing = { deployments: {} };
  }
  const next = {
    ...existing,
    updatedAt: now(),
    deployments: { ...existing.deployments, [record.network]: record },
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/* ------------------------------------------------------------- providers -- */

/**
 * midnight.js packages the real provider needs.
 *
 * This list was corrected against the packages that actually ship on public
 * npm for the pinned midnight-js line (see PINNED_VERSIONS.midnightJs). Two
 * things differ from the published docs, and both are load-bearing:
 *
 *  1. `@midnight-ntwrk/wallet` is NOT the wallet for this line. Its latest
 *     release (5.0.0) is built on `@midnight-ntwrk/zswap@4`, and its
 *     `Wallet.balanceTransaction(tx: zswap.Transaction, ...)` cannot accept the
 *     ledger-v8 `UnboundTransaction` that midnight-js 4.1.1's `WalletProvider`
 *     interface requires. The current headless wallet is the
 *     `@midnight-ntwrk/wallet-sdk` barrel (WalletFacade).
 *  2. midnight-js 4.1.1 needs a private-state provider and the network-id
 *     module too: `deployContract` unconditionally writes the contract
 *     maintenance signing key through `privateStateProvider.setSigningKey`,
 *     and `createUnprovenDeployTx` reads the global network id.
 */
export const REQUIRED_PACKAGES = Object.freeze([
  '@midnight-ntwrk/midnight-js-contracts',
  '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
  '@midnight-ntwrk/midnight-js-http-client-proof-provider',
  '@midnight-ntwrk/midnight-js-node-zk-config-provider',
  '@midnight-ntwrk/midnight-js-level-private-state-provider',
  '@midnight-ntwrk/midnight-js-network-id',
  '@midnight-ntwrk/midnight-js-protocol',
  '@midnight-ntwrk/wallet-sdk',
]);

/**
 * Preflight for the real stack: which of the prerequisites are satisfied right
 * now. Pure-ish - it only attempts module resolution, never a network call.
 * @returns {Promise<{missingPackages: string[], hasSeed: boolean, ready: boolean}>}
 */
export async function checkStackPrerequisites(env = {}, { resolveModule = defaultResolveModule } = {}) {
  const missingPackages = [];
  for (const pkg of REQUIRED_PACKAGES) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await resolveModule(pkg))) missingPackages.push(pkg);
  }
  const hasSeed = hasWalletSeed(env);
  return { missingPackages, hasSeed, ready: missingPackages.length === 0 && hasSeed };
}

async function defaultResolveModule(specifier) {
  try {
    await import(specifier);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------- contract + witnesses -- */

/** Tag midnight.js uses to identify this compiled contract. Arbitrary but stable. */
export const CONTRACT_TAG = 'nightfleet';

/** Where the deploy's private state is filed in the private-state provider. */
export const PRIVATE_STATE_ID = 'nightfleet';

/**
 * Passphrase for the on-disk private-state store. NOT a wallet secret and not a
 * network credential: it encrypts the LevelDB that holds NightFleet's private
 * state and the contract maintenance signing key at rest. It still must never
 * be committed, so it is read from the environment with no default.
 *
 * levelPrivateStateProvider's own policy (quoted from its .d.ts): minimum 16
 * characters, at least 3 of upper/lower/digit/special, no 4+ sequential run.
 */
export const PRIVATE_STATE_PASSWORD_ENV = 'NIGHTFLEET_PRIVATE_STATE_PASSWORD';

/**
 * The private state a freshly deployed NightFleet contract starts from: no
 * secret key, no salt, no board. Mirrors the bootstrap value api/local-game.js
 * feeds `contract.initialState(...)`; real per-player secrets are set later, by
 * the player, never by the deployer.
 */
export function bootstrapPrivateState() {
  return { sk: new Uint8Array(32), salt: new Uint8Array(32), board: Array(64).fill(0n) };
}

/**
 * Witness implementations for the three witnesses declared in
 * contract/src/nightfleet.compact (localSecretKey, myBoard, mySalt). Same shape
 * as api/local-game.js, which drives the same compact-runtime version:
 * `(ctx) => [nextPrivateState, value]`.
 *
 * The deploy transaction runs the constructor only, which touches no witness,
 * so these exist to satisfy the contract binding rather than to be called.
 */
export function deployWitnesses() {
  return {
    localSecretKey: (ctx) => [ctx.privateState, ctx.privateState.sk],
    myBoard: (ctx) => [ctx.privateState, ctx.privateState.board],
    mySalt: (ctx) => [ctx.privateState, ctx.privateState.salt],
  };
}

async function defaultImportModule(specifier) {
  return import(specifier);
}

/**
 * Load the `Contract` class out of the gitignored `contract/managed/` build.
 * Imported by file URL, because the path is absolute and Windows drive letters
 * are not a valid ESM specifier.
 *
 * @returns {Promise<Function>} the generated Contract constructor
 */
export async function loadContractConstructor({ artifacts, importModule = defaultImportModule }) {
  if (!artifacts?.entryPath) {
    throw new DeployError(
      `no compiled contract entry module under ${artifacts?.managedDir ?? 'contract/managed'}\n`
      + `${artifacts?.compileHint ?? 'cd ../contract && npm run compile'}`,
      EXIT.artifacts,
    );
  }
  let mod;
  try {
    mod = await importModule(pathToFileURL(artifacts.entryPath).href);
  } catch (err) {
    throw new DeployError(
      `could not import the compiled contract at ${artifacts.entryPath}: ${err?.message ?? err}\n`
      + 'a stale build is the usual cause - rm -rf ../contract/managed && npm run compile',
      EXIT.artifacts,
    );
  }
  const Ctor = mod?.Contract ?? mod?.default?.Contract;
  if (typeof Ctor !== 'function') {
    throw new DeployError(
      `${artifacts.entryPath} does not export a Contract class; the compile output looks wrong\n`
      + `${artifacts.compileHint}`,
      EXIT.artifacts,
    );
  }
  return Ctor;
}

/* ------------------------------------------------------- midnight wiring -- */

/**
 * Derive the node's WebSocket URL from its RPC URL (https -> wss, http -> ws).
 *
 * UNVERIFIED: shared/network.js has no node-WS preset and the wallet SDK's
 * facade configuration wants a `relayURL` WebSocket. Deriving it by swapping
 * the scheme is an assumption about Preprod's RPC endpoint, not something read
 * off a type or a response. Verified by: connecting a wallet to Preprod once
 * and seeing it sync. Override with $NIGHTFLEET_NODE_WS_URL if it is wrong.
 */
export function nodeWebSocketUrl(config, env = {}) {
  const override = env.NIGHTFLEET_NODE_WS_URL;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  const url = new URL(config.node);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Reachability of the three services a deploy needs. Deliberately only asks
 * "did something answer on this URL" - a 404 from the indexer still proves the
 * host is up, and this must not fail a deploy because a health path was guessed
 * wrong. Genuine protocol failures surface later, from the real call.
 *
 * @returns {Promise<Record<string, {ok: boolean, detail?: string}>>}
 */
export async function probeEndpoints(config, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const reach = async (url) => {
    if (typeof fetchImpl !== 'function') return { ok: false, detail: 'no fetch available in this runtime' };
    try {
      await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      return { ok: true };
    } catch (err) {
      const detail = err?.cause?.code ?? err?.name ?? err?.message ?? 'unreachable';
      return { ok: false, detail: String(detail) };
    }
  };
  const [proofServer, indexer, node] = await Promise.all([
    reach(config.proofServer), reach(config.indexer), reach(config.node),
  ]);
  return { proofServer, indexer, node };
}

/**
 * Build the `MidnightProviders` object `deployContract` takes.
 *
 * Every call here is grounded in a signature read from the installed packages
 * at the pinned midnight-js version:
 *   - `new NodeZkConfigProvider(directory)` - reads `<dir>/keys/<circuit>.prover`
 *     / `.verifier` and `<dir>/zkir/<circuit>.bzkir`, which is exactly the
 *     layout inspectArtifacts() checks for.
 *   - `indexerPublicDataProvider(queryURL, subscriptionURL, webSocketImpl?)`
 *   - `httpClientProofProvider(url, zkConfigProvider, config?)`
 *   - `levelPrivateStateProvider({ privateStoragePasswordProvider, accountId, ... })`
 *
 * @returns {object} MidnightProviders
 */
export function buildDeployProviders({
  config, artifacts, modules, walletProvider, privateStatePassword,
}) {
  const { NodeZkConfigProvider } = modules.zkConfig;
  const { indexerPublicDataProvider } = modules.indexer;
  const { httpClientProofProvider } = modules.proof;
  const { levelPrivateStateProvider } = modules.privateState;

  const zkConfigProvider = new NodeZkConfigProvider(artifacts.managedDir);
  // Scopes the local private-state store to this wallet. Public key material
  // only - the seed itself never reaches here.
  const accountId = Buffer.from(walletProvider.getCoinPublicKey()).toString('hex');

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'nightfleet-private-state',
      signingKeyStoreName: 'nightfleet-private-state-signing-keys',
      privateStoragePasswordProvider: () => privateStatePassword,
      accountId,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWs),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

/**
 * Pull the two public identifiers out of a `FinalizedDeployTxData`.
 *
 * That value is explicitly documented as privacy-sensitive: its `private` half
 * carries the contract maintenance signing key, the initial private state and
 * the unproven transaction. Nothing here reads, copies or returns `private` -
 * only `public.contractAddress`, `public.txId` and `public.blockHeight`, which
 * are on-chain facts.
 */
export function receiptFromDeployTxData(deployTxData) {
  const pub = deployTxData?.public;
  if (!pub || typeof pub !== 'object') {
    throw new DeployError('deployContract returned no public transaction data; refusing to record a deployment');
  }
  return {
    contractAddress: pub.contractAddress,
    txId: pub.txId,
    ...(Number.isInteger(pub.blockHeight) ? { blockHeight: pub.blockHeight } : {}),
  };
}

/**
 * The real DeployProvider: wallet + proof server + indexer + node.
 *
 * The preflight below is unchanged and still fatal: without the packages and a
 * seed this refuses, and says exactly what is missing. Past that point the
 * wiring is real.
 *
 * VERIFICATION STATUS. Every call is written against a `.d.ts` read from the
 * installed package at the pinned version - not from the repo's prose, which
 * was found to name `@midnight-ntwrk/wallet` for the wallet when that package's
 * shipping major targets a different ledger generation (see REQUIRED_PACKAGES).
 * What is NOT verified is that the assembled whole *runs*: no Docker, no proof
 * server and no funded wallet exist on the machine this was written on, so
 * `deployContract` has never been executed once. The individually unverified
 * assumptions are marked UNVERIFIED at their call sites.
 *
 * @param {object} config @param {Record<string,string|undefined>} env
 * @returns {Promise<DeployProvider>}
 */
export async function createMidnightProvider(config, env = {}, deps = {}) {
  const pre = await checkStackPrerequisites(env, deps);
  if (!pre.ready) {
    const lines = ['the real Midnight deploy stack is not available yet:'];
    if (pre.missingPackages.length > 0) {
      lines.push(`  - missing packages: ${pre.missingPackages.join(', ')}`);
      lines.push(`    install them pinned to midnight-js ${PINNED_VERSIONS.midnightJs} (pinned versions)`);
    }
    if (!pre.hasSeed) {
      lines.push(`  - no deploy wallet: set ${WALLET_SEED_ENV} (keep it in .env, which is gitignored)`);
      if (config.faucet) lines.push(`    fund the wallet from the faucet: ${config.faucet}`);
    }
    lines.push(`  - the proof server must be running at ${config.proofServer} (Docker - see the README "Run it" section)`);
    lines.push('use --dry-run to validate the configuration without any of this.');
    throw new DeployError(lines.join('\n'), EXIT.deploy);
  }

  const importModule = deps.importModule ?? defaultImportModule;
  const createWalletProvider = deps.createWalletProvider ?? createMidnightWalletProvider;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const privateStatePassword = env[PRIVATE_STATE_PASSWORD_ENV];
  if (typeof privateStatePassword !== 'string' || privateStatePassword.trim() === '') {
    throw new DeployError(
      `no private-state passphrase: set $${PRIVATE_STATE_PASSWORD_ENV}\n`
      + 'it encrypts the local store that holds the contract maintenance signing key.\n'
      + 'policy: at least 16 characters, 3 of upper/lower/digit/special, no run of 4 sequential characters.\n'
      + 'keep it in .env (gitignored) - lose it and the deployed contract can never be maintained again.',
      EXIT.wallet,
    );
  }

  let modules;
  try {
    const [contracts, indexer, proof, zkConfig, privateState, networkId] = await Promise.all([
      importModule('@midnight-ntwrk/midnight-js-contracts'),
      importModule('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
      importModule('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
      importModule('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
      importModule('@midnight-ntwrk/midnight-js-level-private-state-provider'),
      importModule('@midnight-ntwrk/midnight-js-network-id'),
    ]);
    const compactJs = await importModule('@midnight-ntwrk/midnight-js-protocol/compact-js');
    modules = { contracts, indexer, proof, zkConfig, privateState, networkId, compactJs };
  } catch (err) {
    throw new DeployError(
      `the @midnight-ntwrk deploy packages resolve but will not load: ${err?.message ?? err}\n`
      + `check that every @midnight-ntwrk package is on the same line (midnight-js ${PINNED_VERSIONS.midnightJs}):\n`
      + '  npm ls | grep @midnight-ntwrk',
      EXIT.deploy,
    );
  }

  // Must happen before any transaction is built: createUnprovenDeployTx reads
  // the global network id to encode the wallet's coin public key.
  modules.networkId.setNetworkId(config.networkId);

  const walletProvider = await createWalletProvider(config, env, { ...deps, importModule });

  return {
    name: `midnight-js@${PINNED_VERSIONS.midnightJs}`,

    async probe() {
      const status = await probeEndpoints(config, { fetchImpl });
      return { ...status, wallet: { ok: true, detail: 'seed present' } };
    },

    async deploy({ config: deployConfig, artifacts }) {
      const { CompiledContract } = modules.compactJs;
      const { deployContract } = modules.contracts;

      const Ctor = await loadContractConstructor({ artifacts, importModule });
      const compiledContract = CompiledContract.withCompiledFileAssets(
        CompiledContract.withWitnesses(CompiledContract.make(CONTRACT_TAG, Ctor), deployWitnesses()),
        artifacts.managedDir,
      );

      const providers = buildDeployProviders({
        config: deployConfig, artifacts, modules, walletProvider, privateStatePassword,
      });

      let deployed;
      try {
        deployed = await deployContract(providers, {
          compiledContract,
          privateStateId: PRIVATE_STATE_ID,
          initialPrivateState: bootstrapPrivateState(),
        });
      } catch (err) {
        throw new DeployError(explainDeployFailure(err, deployConfig), EXIT.deploy);
      }
      return receiptFromDeployTxData(deployed?.deployTxData);
    },

    async close() {
      await walletProvider.stop?.();
    },
  };
}

/* ------------------------------------------------------------- the wallet -- */

/** How long a balanced transaction stays valid for. `options.ttl` is a Date. */
const TX_TTL_MS = 60 * 60 * 1000;

/**
 * Derive one role key from the master seed, via the SDK's BIP32 HD wallet.
 * `Roles` is `{NightExternal: 0, NightInternal: 1, Dust: 2, Zswap: 3, Metadata: 4}`
 * and `HDWallet.fromSeed` returns a `seedOk | seedError` union.
 *
 * The seed is used here and nowhere else. It is never returned, stored on an
 * object, or included in an error message.
 */
function deriveRoleKey({ HDWallet, seedHex, role }) {
  const result = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (result.type !== 'seedOk') {
    throw new DeployError(
      `$${WALLET_SEED_ENV} is not a usable BIP32 seed (it must be hex-encoded); the value is not shown`,
      EXIT.wallet,
    );
  }
  const derived = result.hdWallet.selectAccount(0).selectRole(role).deriveKeyAt(0);
  if (derived.type !== 'keyDerived') {
    throw new DeployError(`could not derive the wallet key for role ${role} (${derived.type})`, EXIT.wallet);
  }
  return derived.key;
}

/**
 * Build the `WalletProvider` + `MidnightProvider` pair midnight.js needs, on
 * top of the wallet SDK's `WalletFacade`.
 *
 * Every call is taken from a signature in the installed packages:
 *   - `HDWallet.fromSeed(seed: Uint8Array)`, `Roles`, `deriveKeyAt(index)`
 *   - `createKeystore(secretKey: Uint8Array, networkId: NetworkId)` -> `UnshieldedKeystore`
 *     (`NetworkId = string | typeof mainnet`, so the config's network id string is one)
 *   - `ShieldedWallet(config).startWithSeed(seed)`
 *   - `UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(keystore))`
 *   - `DustWallet(config).startWithSeed(seed, dustParameters)`
 *   - `WalletFacade.init({configuration, shielded, unshielded, dust})`
 *   - `facade.start(shieldedSecretKeys, dustSecretKey)` / `.stop()`
 *   - `facade.balanceUnboundTransaction(tx, {shieldedSecretKeys, dustSecretKey}, {ttl})`
 *   - `facade.signRecipe(recipe, signSegment)` / `.finalizeRecipe(recipe)`
 *   - `facade.submitTransaction(tx) -> Promise<TransactionIdentifier>`
 *   - `ZswapSecretKeys.fromSeed`, `DustSecretKey.fromSeed`, `LedgerParameters.initialParameters()`
 * which together satisfy midnight-js 4.1.1's
 * `WalletProvider {balanceTx(UnboundTransaction, ttl?): Promise<FinalizedTransaction>,
 * getCoinPublicKey(), getEncryptionPublicKey()}` and
 * `MidnightProvider {submitTx(FinalizedTransaction): Promise<TransactionId>}`.
 *
 * UNVERIFIED, in order of risk:
 *   1. The whole facade has never been started here - no proof server, no node,
 *      no funded wallet on this machine. Verified by: `node deploy.js --network
 *      local --confirm` against midnight-local-dev with the proof server up.
 *   2. The `relayURL` is derived from the RPC URL (see nodeWebSocketUrl).
 *   3. `costParameters.feeBlocksMargin: 5` and `additionalFeeOverhead: 0n` are
 *      copied from the SDK's own defaults, not tuned against Preprod fees.
 *      Verified by: one deploy that is not rejected for underpaying.
 */
export async function createMidnightWalletProvider(config, env = {}, deps = {}) {
  const importModule = deps.importModule ?? defaultImportModule;
  const seedHex = env[WALLET_SEED_ENV]?.trim();

  const [walletSdk, ledger] = await Promise.all([
    importModule('@midnight-ntwrk/wallet-sdk'),
    importModule('@midnight-ntwrk/midnight-js-protocol/ledger'),
  ]);
  const {
    HDWallet, Roles, createKeystore, PublicKey,
    ShieldedWallet, UnshieldedWallet, DustWallet, WalletFacade,
    InMemoryTransactionHistoryStorage, WalletEntrySchema, mergeWalletEntries,
  } = walletSdk;
  const { ZswapSecretKeys, DustSecretKey, LedgerParameters } = ledger;

  const seeds = {
    shielded: deriveRoleKey({ HDWallet, seedHex, role: Roles.Zswap }),
    unshielded: deriveRoleKey({ HDWallet, seedHex, role: Roles.NightExternal }),
    dust: deriveRoleKey({ HDWallet, seedHex, role: Roles.Dust }),
  };

  const ledgerParams = LedgerParameters.initialParameters();
  // The SDK's network id type is `WellKnownNetworkId | string`, and its
  // well-known members include the literals "preprod" and "undeployed" - which
  // are exactly the two values shared/network.js produces, so the config's
  // networkId can be handed over as-is.
  const baseConfiguration = {
    indexerClientConnection: { indexerHttpUrl: config.indexer, indexerWsUrl: config.indexerWs },
    provingServerUrl: new URL(config.proofServer),
    networkId: config.networkId,
    relayURL: new URL(nodeWebSocketUrl(config, env)),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { feeBlocksMargin: 5 },
  };

  const keystore = createKeystore(seeds.unshielded, config.networkId);
  const shielded = ShieldedWallet(baseConfiguration).startWithSeed(seeds.shielded);
  const unshielded = UnshieldedWallet({
    ...baseConfiguration,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  }).startWithPublicKey(PublicKey.fromKeyStore(keystore));
  const dust = DustWallet({
    ...baseConfiguration,
    costParameters: { ledgerParams, additionalFeeOverhead: 0n, feeBlocksMargin: 5 },
  }).startWithSeed(seeds.dust, ledgerParams.dust);

  const facade = await WalletFacade.init({
    configuration: baseConfiguration,
    shielded: () => shielded,
    unshielded: () => unshielded,
    dust: () => dust,
  });

  const shieldedSecretKeys = ZswapSecretKeys.fromSeed(seeds.shielded);
  const dustSecretKey = DustSecretKey.fromSeed(seeds.dust);
  await facade.start(shieldedSecretKeys, dustSecretKey);

  return {
    getCoinPublicKey: () => shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => shieldedSecretKeys.encryptionPublicKey,

    async balanceTx(tx, ttl = new Date(Date.now() + TX_TTL_MS)) {
      const recipe = await facade.balanceUnboundTransaction(
        tx, { shieldedSecretKeys, dustSecretKey }, { ttl },
      );
      const signed = await facade.signRecipe(recipe, (payload) => keystore.signData(payload));
      return facade.finalizeRecipe(signed);
    },

    submitTx: (tx) => facade.submitTransaction(tx),

    stop: () => facade.stop(),
  };
}

/**
 * Turn a midnight.js failure into something that names the cause and the fix.
 * Matched on the error class names read from midnight-js-contracts' errors.d.ts
 * rather than on message text, which is not a stable interface.
 */
export function explainDeployFailure(err, config) {
  const name = err?.name ?? err?.constructor?.name ?? '';
  const base = err?.message ?? String(err);
  if (name === 'DeployTxFailedError' || name === 'TxFailedError') {
    // finalizedTxData is privacy-sensitive; only its public txId is quoted.
    const txId = err?.finalizedTxData?.txId;
    return `the node rejected the deploy transaction${txId ? ` (tx ${txId})` : ''}: ${base}\n`
      + `the usual cause is an unfunded wallet - fund it${config?.faucet ? ` from ${config.faucet}` : ''} and retry.`;
  }
  if (name === 'ContractTypeError') {
    return `the compiled contract does not match what is on chain: ${base}\n`
      + 'rebuild against the pinned compiler: rm -rf ../contract/managed && cd ../contract && npm run compile';
  }
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return `a service the deploy needs is not reachable (${code}): ${base}\n`
      + `proof server ${config?.proofServer}, indexer ${config?.indexer}, node ${config?.node}\n`
      + 'start the proof server (Docker, see the README "Run it" section) and check the endpoints.';
  }
  return base;
}

/* ------------------------------------------------------------------- run -- */

function formatRows(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');
}

/**
 * The whole deploy flow, with every side effect injected.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {(config: object, env: object) => Promise<DeployProvider>} [opts.createProvider]
 * @param {typeof nodeFs} [opts.fs]
 * @param {(line: string) => void} [opts.log]
 * @param {(line: string) => void} [opts.errorLog]
 * @param {() => string} [opts.now]
 * @returns {Promise<{code: number, dryRun?: boolean, config?: object, artifacts?: object, record?: object, error?: string}>}
 */
export async function runDeploy({
  argv = [],
  env = {},
  createProvider = createMidnightProvider,
  fs = nodeFs,
  log = console.log,
  errorLog = console.error,
  now = () => new Date().toISOString(),
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    errorLog(err.message);
    return { code: err.code ?? EXIT.usage, error: err.message };
  }
  if (args.help) {
    log(USAGE);
    return { code: EXIT.ok };
  }

  // 1. config
  let config;
  try {
    config = resolveNetwork(args.network, env);
  } catch (err) {
    if (err instanceof NetworkConfigError) {
      errorLog(`config error: ${err.message}`);
      return { code: EXIT.config, error: err.message };
    }
    throw err;
  }

  // 2. artifacts
  const artifacts = inspectArtifacts({ managedDir: args.managedDir, fs });
  const seed = hasWalletSeed(env);

  if (args.dryRun) {
    const plan = {
      dryRun: true,
      network: config.name,
      config: Object.fromEntries(describeNetwork(config)),
      artifacts: { ok: artifacts.ok, managedDir: artifacts.managedDir, entry: artifacts.entry, missing: artifacts.missing },
      walletSeed: seed ? 'present' : 'absent',
      blockers: [],
      wouldDo: [],
    };
    if (!artifacts.ok) plan.blockers.push(`compiled contract missing: ${artifacts.missing.join(', ')}`);
    if (!seed) plan.blockers.push(`no deploy wallet seed in $${WALLET_SEED_ENV}`);
    if (!PINNED_VERSIONS.proofServerTag) {
      plan.blockers.push(`proof-server Docker tag is unpinned (${PINNED_VERSIONS.proofServerImage}:<tag>) - pin it to the ledger/prover version`);
    }
    plan.wouldDo = [
      `load the compiled contract from ${artifacts.entryPath ?? path.join(artifacts.managedDir, ARTIFACT_ENTRY_CANDIDATES[0])}`,
      `build providers: proof server ${config.proofServer}, indexer ${config.indexer}, node ${config.node}`,
      `sign with the wallet from $${WALLET_SEED_ENV} on network id "${config.networkId}"`,
      'submit the deploy transaction and wait for confirmation',
      `write contractAddress + txId to ${args.outFile}`,
    ];

    if (args.json) {
      log(JSON.stringify(plan, null, 2));
    } else {
      log(`nightfleet deploy - DRY RUN (nothing is deployed, no files are written)\n`);
      log('configuration:');
      log(formatRows(describeNetwork(config)));
      log('\ncompiled contract:');
      log(formatRows([
        ['managed dir', artifacts.managedDir],
        ['status', artifacts.ok ? 'present' : 'MISSING'],
        ['entry module', artifacts.entry ?? '-'],
        ['proving material', artifacts.foundDirs.length ? artifacts.foundDirs.join(', ') : '-'],
        ...(artifacts.ok ? [] : [['missing', artifacts.missing.join(', ')], ['fix', artifacts.compileHint]]),
      ]));
      log('\nwallet:');
      log(formatRows([
        ['seed', seed ? `present ($${WALLET_SEED_ENV} is set; value never printed)` : `absent (set $${WALLET_SEED_ENV})`],
        ...(config.faucet ? [['faucet', config.faucet]] : []),
      ]));
      log('\nwould do:');
      plan.wouldDo.forEach((step, i) => log(`  ${i + 1}. ${step}`));
      log(`\nblockers (${plan.blockers.length}):`);
      if (plan.blockers.length === 0) log('  none - a real deploy would run: node deploy.js --network ' + config.name + ' --confirm');
      else plan.blockers.forEach((b) => log(`  - ${b}`));
    }
    return { code: EXIT.ok, dryRun: true, config, artifacts, plan };
  }

  // 3. real deploy - each prerequisite is fatal, with its own exit code
  if (!artifacts.ok) {
    const message = `compiled contract not found under ${artifacts.managedDir} (missing: ${artifacts.missing.join(', ')})\n${artifacts.compileHint}`;
    errorLog(message);
    return { code: EXIT.artifacts, error: message, artifacts };
  }
  if (!seed) {
    const message = `no deploy wallet: set $${WALLET_SEED_ENV}`
      + (config.faucet ? ` and fund it from ${config.faucet}` : '')
      + '\nkeep the seed in .env (gitignored) - never commit it.';
    errorLog(message);
    return { code: EXIT.wallet, error: message };
  }
  if (!args.confirm) {
    const message = `refusing to deploy to "${config.name}" without --confirm (use --dry-run to preview)`;
    errorLog(message);
    return { code: EXIT.unconfirmed, error: message };
  }

  let provider;
  try {
    provider = await createProvider(config, env);
    log(`deploying to ${config.name} (${config.networkId}) via ${provider.name ?? 'provider'} ...`);

    if (typeof provider.probe === 'function') {
      const status = await provider.probe();
      const down = Object.entries(status ?? {}).filter(([, v]) => !v?.ok);
      log('preflight:');
      log(formatRows(Object.entries(status ?? {}).map(([k, v]) => [k, v?.ok ? 'ok' : `DOWN${v?.detail ? ` (${v.detail})` : ''}`])));
      if (down.length > 0) {
        throw new DeployError(
          `preflight failed: ${down.map(([k, v]) => `${k}${v?.detail ? ` (${v.detail})` : ''}`).join(', ')}`,
        );
      }
    }

    const receipt = assertDeployReceipt(await provider.deploy({ config, artifacts }));
    const record = buildDeploymentRecord({
      config, receipt, deployedAt: now(), provider: provider.name ?? 'provider',
    });
    writeDeploymentRecord({ outFile: args.outFile, record, fs, now });

    if (args.json) {
      log(JSON.stringify(record, null, 2));
    } else {
      log('\ndeployed:');
      log(formatRows([
        ['contract address', record.contractAddress],
        ['deploy tx', record.txId],
        ...(record.blockHeight === undefined ? [] : [['block', String(record.blockHeight)]]),
        ['network', `${record.network} (${record.networkId})`],
        ['recorded in', args.outFile],
        ...(record.links.address ? [['explorer', record.links.address]] : []),
      ]));
    }
    return { code: EXIT.ok, config, artifacts, record };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog(`deploy failed: ${message}`);
    return { code: err?.code ?? EXIT.deploy, error: message };
  } finally {
    try {
      await provider?.close?.();
    } catch { /* closing a broken provider must not mask the real error */ }
  }
}

/* istanbul ignore next - entrypoint */
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  // Bare `node deploy.js` is a preview, not a deploy.
  const effective = argv.some((a) => a === '--dry-run' || a === '--confirm' || a === '-h' || a === '--help')
    ? argv
    : [...argv, '--dry-run'];
  const { code } = await runDeploy({ argv: effective, env: process.env });
  process.exitCode = code;
}
