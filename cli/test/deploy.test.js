// Deploy CLI tests. Everything external is injected, so this suite runs with no
// Docker, no wallet and no contract/managed/: artifacts come from a temp-dir
// fixture and the chain comes from a fake DeployProvider.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EXIT, DeployError, ARTIFACT_ENTRY_CANDIDATES, REQUIRED_PACKAGES,
  PRIVATE_STATE_ID, PRIVATE_STATE_PASSWORD_ENV, CONTRACT_TAG,
  parseArgs, inspectArtifacts, assertDeployReceipt, buildDeploymentRecord,
  writeDeploymentRecord, checkStackPrerequisites, createMidnightProvider, runDeploy,
  bootstrapPrivateState, deployWitnesses, loadContractConstructor, nodeWebSocketUrl,
  probeEndpoints, buildDeployProviders, receiptFromDeployTxData, explainDeployFailure,
  createMidnightWalletProvider,
} from '../deploy.js';
import { ENV_VARS, WALLET_SEED_ENV } from '../../shared/network.js';

const SEED = 'never-print-this-seed-0123456789';
/** A hex seed, so the HD-wallet fake sees something plausible. Not a real key. */
const HEX_SEED = 'ab'.repeat(32);
const PASSWORD = 'Correct-Horse-Battery-Staple-7';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfleet-deploy-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A managed/ dir that looks like a successful `compact compile`. */
function fixtureManagedDir({ entry = true, keys = true, zkir = true } = {}) {
  const dir = path.join(tmp, 'managed');
  fs.mkdirSync(path.join(dir, 'contract'), { recursive: true });
  if (entry) fs.writeFileSync(path.join(dir, 'contract', 'index.js'), 'export const Contract = null;\n');
  if (keys) fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
  if (zkir) fs.mkdirSync(path.join(dir, 'zkir'), { recursive: true });
  return dir;
}

/** Capture stdout/stderr instead of writing to the terminal. */
function recorder() {
  const out = [];
  const err = [];
  return { out, err, log: (l) => out.push(String(l)), errorLog: (l) => err.push(String(l)), text: () => [...out, ...err].join('\n') };
}

/** A fake DeployProvider - this is the seam the real midnight.js stack plugs into. */
function fakeProvider(overrides = {}) {
  const calls = { probe: 0, deploy: 0, close: 0, requests: [] };
  const provider = {
    name: 'fake',
    calls,
    async probe() { calls.probe += 1; return overrides.status ?? { node: { ok: true }, indexer: { ok: true }, proofServer: { ok: true }, wallet: { ok: true } }; },
    async deploy(req) {
      calls.deploy += 1;
      calls.requests.push(req);
      if (overrides.deployError) throw overrides.deployError;
      return overrides.receipt ?? { contractAddress: '0200cafebabe', txId: '0x1234abcd', blockHeight: 42 };
    },
    async close() { calls.close += 1; },
  };
  return provider;
}

describe('parseArgs', () => {
  it('defaults to a non-dry, non-confirmed preprod run with repo-relative paths', () => {
    const args = parseArgs([]);
    expect(args).toMatchObject({ network: undefined, dryRun: false, confirm: false, json: false, help: false });
    expect(args.managedDir).toMatch(/contract[\\/]managed$/);
    expect(args.outFile).toMatch(/shared[\\/]deployments\.json$/);
  });

  it('parses every flag', () => {
    const args = parseArgs(['--network', 'local', '--managed', '/m', '--out', '/o.json', '--confirm', '--json']);
    expect(args).toMatchObject({ network: 'local', managedDir: '/m', outFile: '/o.json', confirm: true, json: true });
  });

  it('rejects an unknown argument with the usage exit code', () => {
    expect(() => parseArgs(['--deploy-to-mainnet'])).toThrow(DeployError);
    try { parseArgs(['--deploy-to-mainnet']); } catch (e) { expect(e.code).toBe(EXIT.usage); }
  });

  it('rejects a flag whose value is missing or is another flag', () => {
    expect(() => parseArgs(['--network'])).toThrow(/--network needs a value/);
    expect(() => parseArgs(['--network', '--json'])).toThrow(/--network needs a value/);
  });

  it('refuses --dry-run together with --confirm', () => {
    expect(() => parseArgs(['--dry-run', '--confirm'])).toThrow(/mutually exclusive/);
  });
});

describe('inspectArtifacts', () => {
  it('reports a complete managed/ dir as ok', () => {
    const a = inspectArtifacts({ managedDir: fixtureManagedDir() });
    expect(a.ok).toBe(true);
    expect(a.missing).toEqual([]);
    expect(a.entry).toBe(ARTIFACT_ENTRY_CANDIDATES[0]);
    expect(fs.existsSync(a.entryPath)).toBe(true);
    expect(a.foundDirs).toEqual(['keys', 'zkir']);
  });

  it('handles an absent managed/ dir without throwing (it is gitignored)', () => {
    const a = inspectArtifacts({ managedDir: path.join(tmp, 'does-not-exist') });
    expect(a.ok).toBe(false);
    expect(a.dirPresent).toBe(false);
    expect(a.entry).toBeNull();
    expect(a.entryPath).toBeNull();
    expect(a.missing).toEqual([path.join(tmp, 'does-not-exist')]);
    expect(a.compileHint).toContain('npm run compile');
  });

  it('names exactly what is missing from a partial compile', () => {
    const a = inspectArtifacts({ managedDir: fixtureManagedDir({ keys: false }) });
    expect(a.ok).toBe(false);
    expect(a.missing).toEqual(['keys/']);
    expect(a.entry).toBe(ARTIFACT_ENTRY_CANDIDATES[0]);
  });

  it('reports a missing entry module when only the proving material is there', () => {
    const a = inspectArtifacts({ managedDir: fixtureManagedDir({ entry: false }) });
    expect(a.ok).toBe(false);
    expect(a.missing[0]).toContain('contract');
  });

  it('survives a filesystem that throws', () => {
    const throwingFs = { existsSync: () => { throw new Error('EACCES'); } };
    expect(inspectArtifacts({ managedDir: '/x', fs: throwingFs }).ok).toBe(false);
  });
});

describe('assertDeployReceipt', () => {
  it('accepts and trims a well-formed receipt', () => {
    expect(assertDeployReceipt({ contractAddress: ' 0200aa ', txId: ' 0xbb ', blockHeight: 7 }))
      .toEqual({ contractAddress: '0200aa', txId: '0xbb', blockHeight: 7 });
  });

  it('accepts a receipt without a block height', () => {
    expect(assertDeployReceipt({ contractAddress: '0200aa', txId: '0xbb' }))
      .toEqual({ contractAddress: '0200aa', txId: '0xbb' });
  });

  it('rejects anything that is not a usable proof of deployment', () => {
    expect(() => assertDeployReceipt(undefined)).toThrow(/instead of a deploy receipt/);
    expect(() => assertDeployReceipt({ txId: '0xbb' })).toThrow(/no contractAddress/);
    expect(() => assertDeployReceipt({ contractAddress: '  ', txId: '0xbb' })).toThrow(/no contractAddress/);
    // submitTxAsync returns no txId by design: the indexer confirms instead
    expect(assertDeployReceipt({ contractAddress: '0200aa' }).txId).toBe('async-submit-confirmed-by-indexer');
    expect(() => assertDeployReceipt({ contractAddress: '0200aa', txId: '0xbb', blockHeight: -1 }))
      .toThrow(/invalid blockHeight/);
    expect(() => assertDeployReceipt({ contractAddress: '0200aa', txId: '0xbb', blockHeight: 'soon' }))
      .toThrow(/invalid blockHeight/);
  });
});

describe('deployment record', () => {
  const config = {
    name: 'preprod', networkId: 'preprod', node: 'https://n', indexer: 'https://i',
    indexerWs: 'wss://i', proofServer: 'http://localhost:6300', faucet: null,
    explorer: 'https://explorer.example', versions: { midnightJs: '4.1.1' },
  };
  const receipt = { contractAddress: '0200aa', txId: '0xbb', blockHeight: 9 };

  it('records the two public identifiers plus endpoints, versions and links', () => {
    const rec = buildDeploymentRecord({ config, receipt, deployedAt: '2026-10-01T00:00:00Z', provider: 'fake' });
    expect(rec).toMatchObject({
      network: 'preprod', networkId: 'preprod', contractAddress: '0200aa', txId: '0xbb',
      blockHeight: 9, deployedAt: '2026-10-01T00:00:00Z', provider: 'fake',
    });
    expect(rec.endpoints.proofServer).toBe('http://localhost:6300');
    expect(rec.links.address).toBe('https://explorer.example/address/0200aa');
    expect(rec.links.tx).toBe('https://explorer.example/tx/0xbb');
  });

  it('keeps one entry per network and refreshes updatedAt', () => {
    const outFile = path.join(tmp, 'nested', 'deployments.json');
    const local = buildDeploymentRecord({ config: { ...config, name: 'local', networkId: 'undeployed', explorer: null }, receipt, deployedAt: 'a', provider: 'fake' });
    const preprod = buildDeploymentRecord({ config, receipt: { ...receipt, txId: '0xcc' }, deployedAt: 'b', provider: 'fake' });
    writeDeploymentRecord({ outFile, record: local, now: () => 't1' });
    const after = writeDeploymentRecord({ outFile, record: preprod, now: () => 't2' });
    expect(after.updatedAt).toBe('t2');
    expect(Object.keys(after.deployments).sort()).toEqual(['local', 'preprod']);
    expect(after.deployments.preprod.txId).toBe('0xcc');
    expect(JSON.parse(fs.readFileSync(outFile, 'utf8'))).toEqual(after);
  });

  it('recovers from a corrupt existing file rather than losing the deploy', () => {
    const outFile = path.join(tmp, 'deployments.json');
    fs.writeFileSync(outFile, 'not json at all');
    const rec = buildDeploymentRecord({ config, receipt, deployedAt: 'a', provider: 'fake' });
    const after = writeDeploymentRecord({ outFile, record: rec, now: () => 't' });
    expect(after.deployments.preprod.contractAddress).toBe('0200aa');
  });
});

describe('runDeploy - help and configuration', () => {
  it('prints usage and exits 0', async () => {
    const io = recorder();
    const r = await runDeploy({ argv: ['--help'], ...io });
    expect(r.code).toBe(EXIT.ok);
    expect(io.out.join('\n')).toContain('nightfleet deploy');
    expect(io.out.join('\n')).toContain('--dry-run');
  });

  it('exits with the usage code on a bad argument', async () => {
    const io = recorder();
    const r = await runDeploy({ argv: ['--nope'], ...io });
    expect(r.code).toBe(EXIT.usage);
    expect(io.err.join('\n')).toContain('unknown argument');
  });

  it('exits with the config code for an unknown network', async () => {
    const io = recorder();
    const r = await runDeploy({ argv: ['--network', 'mainnet', '--dry-run'], ...io });
    expect(r.code).toBe(EXIT.config);
    expect(io.err.join('\n')).toMatch(/unknown network/);
  });

  it('exits with the config code for an invalid env override', async () => {
    const io = recorder();
    const r = await runDeploy({
      argv: ['--dry-run'], env: { [ENV_VARS.indexer]: 'not-a-url' }, ...io,
    });
    expect(r.code).toBe(EXIT.config);
    expect(io.err.join('\n')).toContain(ENV_VARS.indexer);
  });

  it('applies env overrides to the resolved config', async () => {
    const io = recorder();
    const r = await runDeploy({
      argv: ['--dry-run', '--managed', fixtureManagedDir()],
      env: { [ENV_VARS.network]: 'local', [ENV_VARS.proofServer]: 'http://localhost:7300' },
      ...io,
    });
    expect(r.config.name).toBe('local');
    expect(r.config.proofServer).toBe('http://localhost:7300');
    expect(io.out.join('\n')).toContain('http://localhost:7300');
  });
});

describe('runDeploy - dry run', () => {
  it('reports the plan and every blocker with no Docker, wallet or artifacts', async () => {
    const io = recorder();
    const writeSpy = vi.fn();
    const r = await runDeploy({
      argv: ['--dry-run', '--managed', path.join(tmp, 'absent'), '--out', path.join(tmp, 'out.json')],
      env: {},
      fs: { ...fs, writeFileSync: writeSpy, mkdirSync: vi.fn() },
      ...io,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.dryRun).toBe(true);
    const text = io.out.join('\n');
    expect(text).toContain('DRY RUN');
    expect(text).toContain('MISSING');
    expect(text).toContain('npm run compile');
    expect(r.plan.blockers).toEqual([
      expect.stringContaining('compiled contract missing'),
      expect.stringContaining(WALLET_SEED_ENV),
      expect.stringContaining('proof-server Docker tag is unpinned'),
    ]);
    // a dry run must never write anything
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'out.json'))).toBe(false);
  });

  it('never calls the provider factory', async () => {
    const createProvider = vi.fn();
    await runDeploy({ argv: ['--dry-run'], env: {}, createProvider, ...recorder() });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('drops the artifact and wallet blockers once both exist', async () => {
    const io = recorder();
    const r = await runDeploy({
      argv: ['--dry-run', '--managed', fixtureManagedDir()],
      env: { [WALLET_SEED_ENV]: SEED },
      ...io,
    });
    expect(r.plan.blockers).toEqual([expect.stringContaining('proof-server Docker tag')]);
    expect(io.out.join('\n')).toContain('present');
  });

  it('--json emits a parseable plan that names the steps and leaks no seed', async () => {
    const io = recorder();
    const r = await runDeploy({
      argv: ['--dry-run', '--json', '--managed', fixtureManagedDir()],
      env: { [WALLET_SEED_ENV]: SEED },
      ...io,
    });
    expect(r.code).toBe(EXIT.ok);
    const plan = JSON.parse(io.out.join('\n'));
    expect(plan.dryRun).toBe(true);
    expect(plan.network).toBe('preprod');
    expect(plan.walletSeed).toBe('present');
    expect(plan.wouldDo).toHaveLength(5);
    expect(plan.wouldDo.join(' ')).toMatch(/submit the deploy transaction/);
    expect(io.text()).not.toContain(SEED);
  });
});

describe('runDeploy - preconditions for a real deploy', () => {
  const base = { env: { [WALLET_SEED_ENV]: SEED } };

  it('fails on missing artifacts with the compile command', async () => {
    const io = recorder();
    const r = await runDeploy({
      argv: ['--confirm', '--managed', path.join(tmp, 'absent')], ...base, ...io,
    });
    expect(r.code).toBe(EXIT.artifacts);
    expect(io.err.join('\n')).toContain('npm run compile');
  });

  it('fails on a missing wallet seed and points at the faucet', async () => {
    const io = recorder();
    const r = await runDeploy({
      argv: ['--confirm', '--managed', fixtureManagedDir()], env: {}, ...io,
    });
    expect(r.code).toBe(EXIT.wallet);
    expect(io.err.join('\n')).toContain(WALLET_SEED_ENV);
    expect(io.err.join('\n')).toContain('nethermind.dev');
  });

  it('refuses to deploy without --confirm', async () => {
    const io = recorder();
    const createProvider = vi.fn();
    const r = await runDeploy({
      argv: ['--managed', fixtureManagedDir()], ...base, createProvider, ...io,
    });
    expect(r.code).toBe(EXIT.unconfirmed);
    expect(io.err.join('\n')).toContain('--confirm');
    expect(createProvider).not.toHaveBeenCalled();
  });
});

describe('runDeploy - full flow against a mock provider', () => {
  const env = { [WALLET_SEED_ENV]: SEED };

  it('deploys, records the address and tx, and closes the provider', async () => {
    const io = recorder();
    const provider = fakeProvider();
    const outFile = path.join(tmp, 'deployments.json');
    const managedDir = fixtureManagedDir();
    const r = await runDeploy({
      argv: ['--network', 'preprod', '--confirm', '--managed', managedDir, '--out', outFile],
      env, createProvider: async () => provider, now: () => '2026-10-01T12:00:00.000Z', ...io,
    });

    expect(r.code).toBe(EXIT.ok);
    expect(provider.calls).toMatchObject({ probe: 1, deploy: 1, close: 1 });
    // the provider receives the validated config and the inspected artifacts
    expect(provider.calls.requests[0].config.networkId).toBe('preprod');
    expect(provider.calls.requests[0].artifacts.entryPath).toBe(path.join(managedDir, 'contract', 'index.js'));

    expect(r.record).toMatchObject({
      contractAddress: '0200cafebabe', txId: '0x1234abcd', blockHeight: 42,
      network: 'preprod', deployedAt: '2026-10-01T12:00:00.000Z', provider: 'fake',
    });
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(written.deployments.preprod.contractAddress).toBe('0200cafebabe');
    expect(written.deployments.preprod.txId).toBe('0x1234abcd');

    const text = io.out.join('\n');
    expect(text).toContain('0200cafebabe');
    expect(text).toContain('0x1234abcd');
    expect(text).toContain(outFile);
    expect(io.text()).not.toContain(SEED);
  });

  it('--json prints the record itself', async () => {
    const io = recorder();
    const r = await runDeploy({
      argv: ['--confirm', '--json', '--managed', fixtureManagedDir(), '--out', path.join(tmp, 'd.json')],
      env, createProvider: async () => fakeProvider(), now: () => 't', ...io,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(io.out.at(-1)).contractAddress).toBe('0200cafebabe');
  });

  it('aborts when preflight finds a component down, and writes nothing', async () => {
    const io = recorder();
    const outFile = path.join(tmp, 'deployments.json');
    const provider = fakeProvider({
      status: { node: { ok: true }, indexer: { ok: true }, proofServer: { ok: false, detail: 'ECONNREFUSED :6300' } },
    });
    const r = await runDeploy({
      argv: ['--confirm', '--managed', fixtureManagedDir(), '--out', outFile],
      env, createProvider: async () => provider, ...io,
    });
    expect(r.code).toBe(EXIT.deploy);
    expect(io.err.join('\n')).toContain('preflight failed');
    expect(io.err.join('\n')).toContain('ECONNREFUSED');
    expect(provider.calls.deploy).toBe(0);
    expect(provider.calls.close).toBe(1);
    expect(fs.existsSync(outFile)).toBe(false);
  });

  it('surfaces a deploy failure, still closes, and writes nothing', async () => {
    const io = recorder();
    const outFile = path.join(tmp, 'deployments.json');
    const provider = fakeProvider({ deployError: new Error('proof generation timed out') });
    const r = await runDeploy({
      argv: ['--confirm', '--managed', fixtureManagedDir(), '--out', outFile],
      env, createProvider: async () => provider, ...io,
    });
    expect(r.code).toBe(EXIT.deploy);
    expect(r.error).toBe('proof generation timed out');
    expect(io.err.join('\n')).toContain('deploy failed: proof generation timed out');
    expect(provider.calls.close).toBe(1);
    expect(fs.existsSync(outFile)).toBe(false);
  });

  it('refuses to record a deployment when the provider returns a junk receipt', async () => {
    const io = recorder();
    const outFile = path.join(tmp, 'deployments.json');
    const provider = fakeProvider({ receipt: { txId: '0xbb' } });
    const r = await runDeploy({
      argv: ['--confirm', '--managed', fixtureManagedDir(), '--out', outFile],
      env, createProvider: async () => provider, ...io,
    });
    expect(r.code).toBe(EXIT.deploy);
    expect(r.error).toMatch(/no contractAddress/);
    expect(fs.existsSync(outFile)).toBe(false);
  });

  it('reports a provider that cannot even be constructed', async () => {
    const io = recorder();
    const r = await runDeploy({
      argv: ['--confirm', '--managed', fixtureManagedDir(), '--out', path.join(tmp, 'd.json')],
      env, createProvider: async () => { throw new DeployError('proof server unreachable', EXIT.deploy); }, ...io,
    });
    expect(r.code).toBe(EXIT.deploy);
    expect(io.err.join('\n')).toContain('proof server unreachable');
  });

  it('a provider whose close() throws does not mask the deploy result', async () => {
    const io = recorder();
    const provider = fakeProvider();
    provider.close = async () => { throw new Error('socket already gone'); };
    const r = await runDeploy({
      argv: ['--confirm', '--managed', fixtureManagedDir(), '--out', path.join(tmp, 'd.json')],
      env, createProvider: async () => provider, ...io,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.record.contractAddress).toBe('0200cafebabe');
  });

  it('tolerates a provider with no probe/close (the interface minimum)', async () => {
    const io = recorder();
    const r = await runDeploy({
      argv: ['--confirm', '--managed', fixtureManagedDir(), '--out', path.join(tmp, 'd.json')],
      env,
      createProvider: async () => ({ deploy: async () => ({ contractAddress: '0200ff', txId: '0xff' }) }),
      now: () => 't', ...io,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.record.provider).toBe('provider');
  });
});

describe('the real Midnight provider', () => {
  it('names every missing prerequisite instead of failing vaguely', async () => {
    const pre = await checkStackPrerequisites({}, { resolveModule: async () => false });
    expect(pre.ready).toBe(false);
    expect(pre.hasSeed).toBe(false);
    expect(pre.missingPackages).toEqual([...REQUIRED_PACKAGES]);
  });

  it('is not ready with packages but no seed, nor with a seed but no packages', async () => {
    expect((await checkStackPrerequisites({ [WALLET_SEED_ENV]: SEED }, { resolveModule: async () => false })).ready).toBe(false);
    expect((await checkStackPrerequisites({}, { resolveModule: async () => true })).ready).toBe(false);
    expect((await checkStackPrerequisites({ [WALLET_SEED_ENV]: SEED }, { resolveModule: async () => true })).ready).toBe(true);
  });

  it('throws an actionable error listing packages, wallet, faucet and proof server', async () => {
    const config = {
      name: 'preprod', networkId: 'preprod', proofServer: 'http://localhost:6300',
      faucet: 'https://faucet.example',
    };
    const err = await createMidnightProvider(config, {}, { resolveModule: async () => false })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect(err.message).toContain(REQUIRED_PACKAGES[0]);
    expect(err.message).toContain(WALLET_SEED_ENV);
    expect(err.message).toContain('https://faucet.example');
    expect(err.message).toContain('http://localhost:6300');
    expect(err.message).toContain('--dry-run');
  });

  it('gets past the preflight once it is satisfied, and then names the next real blocker', async () => {
    const err = await createMidnightProvider(
      { name: 'local', networkId: 'undeployed', proofServer: 'http://localhost:6300', faucet: null },
      { [WALLET_SEED_ENV]: SEED },
      { resolveModule: async () => true },
    ).then(() => null, (e) => e);
    // The preflight passed (nothing about missing packages), so the failure is
    // the next genuine prerequisite rather than a blanket refusal.
    expect(err).toBeInstanceOf(DeployError);
    expect(err.code).toBe(EXIT.wallet);
    expect(err.message).toContain(PRIVATE_STATE_PASSWORD_ENV);
    expect(err.message).not.toMatch(/missing packages/);
    expect(err.message).not.toContain(SEED);
  });
});

/* ==========================================================================
 * The tests below drive the real provider wiring through injected fakes for
 * the @midnight-ntwrk modules. They prove that the arguments this CLI passes
 * are the ones it intends to pass - the plumbing. They do NOT prove the wiring
 * works against the real packages: nothing here loads midnight.js, starts a
 * proof server, or touches a chain, and no real deploy has ever been executed
 * against this code. Read deploy.js's VERIFICATION STATUS note before trusting
 * a green run here as evidence that a Preprod deploy will succeed.
 * ======================================================================== */

describe('contract loading', () => {
  it('starts every deploy from an empty private state and no player secrets', () => {
    const ps = bootstrapPrivateState();
    expect(ps.sk).toEqual(new Uint8Array(32));
    expect(ps.salt).toEqual(new Uint8Array(32));
    expect(ps.board).toHaveLength(64);
    expect(new Set(ps.board)).toEqual(new Set([0n]));
  });

  it('implements exactly the three witnesses the contract declares', () => {
    const w = deployWitnesses();
    expect(Object.keys(w).sort()).toEqual(['localSecretKey', 'myBoard', 'mySalt']);
    const ctx = { privateState: { sk: 'SK', salt: 'SALT', board: 'BOARD' } };
    expect(w.localSecretKey(ctx)).toEqual([ctx.privateState, 'SK']);
    expect(w.myBoard(ctx)).toEqual([ctx.privateState, 'BOARD']);
    expect(w.mySalt(ctx)).toEqual([ctx.privateState, 'SALT']);
  });

  it('imports the Contract class from the compiled entry module by file URL', async () => {
    const managedDir = fixtureManagedDir();
    const artifacts = inspectArtifacts({ managedDir });
    const seen = [];
    const Ctor = await loadContractConstructor({
      artifacts,
      importModule: async (spec) => { seen.push(spec); return { Contract: class {} }; },
    });
    expect(typeof Ctor).toBe('function');
    expect(seen[0].startsWith('file:')).toBe(true);
    expect(decodeURIComponent(seen[0])).toContain('index.js');
  });

  it('accepts a default-exported Contract too', async () => {
    const artifacts = inspectArtifacts({ managedDir: fixtureManagedDir() });
    const Ctor = await loadContractConstructor({
      artifacts, importModule: async () => ({ default: { Contract: class {} } }),
    });
    expect(typeof Ctor).toBe('function');
  });

  it('blames the compile, not the deploy, when managed/ is absent', async () => {
    const artifacts = inspectArtifacts({ managedDir: path.join(tmp, 'absent') });
    const err = await loadContractConstructor({ artifacts }).then(() => null, (e) => e);
    expect(err.code).toBe(EXIT.artifacts);
    expect(err.message).toContain('npm run compile');
  });

  it('explains a stale build when the entry module will not import', async () => {
    const artifacts = inspectArtifacts({ managedDir: fixtureManagedDir() });
    const err = await loadContractConstructor({
      artifacts, importModule: async () => { throw new Error('Version mismatch'); },
    }).then(() => null, (e) => e);
    expect(err.code).toBe(EXIT.artifacts);
    expect(err.message).toContain('Version mismatch');
    expect(err.message).toContain('rm -rf');
  });

  it('rejects a compile output with no Contract export', async () => {
    const artifacts = inspectArtifacts({ managedDir: fixtureManagedDir() });
    const err = await loadContractConstructor({
      artifacts, importModule: async () => ({ ledger: {} }),
    }).then(() => null, (e) => e);
    expect(err.code).toBe(EXIT.artifacts);
    expect(err.message).toContain('does not export a Contract class');
  });
});

describe('receiptFromDeployTxData', () => {
  it('reads only the public half, never the private one', () => {
    const receipt = receiptFromDeployTxData({
      public: { contractAddress: '0200aa', txId: '0xbb', blockHeight: 12, txHash: 'h' },
      private: { signingKey: 'SIGNING-KEY-MUST-NOT-LEAK', initialPrivateState: { sk: 'secret' } },
    });
    expect(receipt).toEqual({ contractAddress: '0200aa', txId: '0xbb', blockHeight: 12 });
    expect(JSON.stringify(receipt)).not.toContain('SIGNING-KEY-MUST-NOT-LEAK');
  });

  it('omits a block height the node did not give as an integer', () => {
    expect(receiptFromDeployTxData({ public: { contractAddress: '0200aa', txId: '0xbb' } }))
      .toEqual({ contractAddress: '0200aa', txId: '0xbb' });
    expect(receiptFromDeployTxData({ public: { contractAddress: '0200aa', txId: '0xbb', blockHeight: null } }))
      .toEqual({ contractAddress: '0200aa', txId: '0xbb' });
  });

  it('refuses a deployContract result with no public data', () => {
    expect(() => receiptFromDeployTxData(undefined)).toThrow(/no public transaction data/);
    expect(() => receiptFromDeployTxData({ private: {} })).toThrow(/no public transaction data/);
  });

  it('feeds assertDeployReceipt, which is what actually guards the record', () => {
    const receipt = receiptFromDeployTxData({ public: { contractAddress: ' 0200aa ', txId: ' 0xbb ', blockHeight: 3 } });
    expect(assertDeployReceipt(receipt)).toEqual({ contractAddress: '0200aa', txId: '0xbb', blockHeight: 3 });
  });
});

describe('nodeWebSocketUrl', () => {
  it('swaps the scheme (this derivation is an assumption, see deploy.js)', () => {
    expect(nodeWebSocketUrl({ node: 'https://rpc.example/x' })).toBe('wss://rpc.example/x');
    expect(nodeWebSocketUrl({ node: 'http://localhost:9944' })).toBe('ws://localhost:9944/');
  });

  it('prefers an explicit override', () => {
    expect(nodeWebSocketUrl({ node: 'https://rpc.example' }, { NIGHTFLEET_NODE_WS_URL: ' wss://other/ws ' }))
      .toBe('wss://other/ws');
  });
});

describe('probeEndpoints', () => {
  const config = { proofServer: 'http://localhost:6300', indexer: 'https://ix/graphql', node: 'https://node' };

  it('treats any answer as reachable - a 404 still proves the host is up', async () => {
    const status = await probeEndpoints(config, { fetchImpl: async () => ({ status: 404 }) });
    expect(status).toEqual({ proofServer: { ok: true }, indexer: { ok: true }, node: { ok: true } });
  });

  it('reports which service is down and why', async () => {
    const status = await probeEndpoints(config, {
      fetchImpl: async (url) => {
        if (url.includes('6300')) { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
        return { status: 200 };
      },
    });
    expect(status.proofServer).toEqual({ ok: false, detail: 'ECONNREFUSED' });
    expect(status.indexer.ok).toBe(true);
  });

  it('does not pretend everything is fine when there is no fetch', async () => {
    const status = await probeEndpoints(config, { fetchImpl: null });
    expect(status.node.ok).toBe(false);
    expect(status.node.detail).toContain('fetch');
  });
});

describe('explainDeployFailure', () => {
  const config = { proofServer: 'http://ps', indexer: 'http://ix', node: 'http://nd', faucet: 'https://faucet.example' };

  it('points a rejected transaction at the faucet, quoting only the public tx id', () => {
    const err = new Error('deploy tx failed');
    err.name = 'DeployTxFailedError';
    err.finalizedTxData = { txId: '0xdead', tx: 'PRIVATE-TX-OBJECT' };
    const message = explainDeployFailure(err, config);
    expect(message).toContain('0xdead');
    expect(message).toContain('https://faucet.example');
    expect(message).not.toContain('PRIVATE-TX-OBJECT');
  });

  it('points a verifier-key mismatch at a recompile', () => {
    const err = new Error('keys differ');
    err.name = 'ContractTypeError';
    expect(explainDeployFailure(err, config)).toContain('npm run compile');
  });

  it('points a refused connection at the proof server and the endpoints', () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    const message = explainDeployFailure(err, config);
    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain('http://ps');
    expect(message).toContain('README');
  });

  it('passes anything else through unchanged rather than inventing a cause', () => {
    expect(explainDeployFailure(new Error('something new'), config)).toBe('something new');
  });
});

describe('buildDeployProviders', () => {
  const config = {
    name: 'preprod', networkId: 'preprod', node: 'https://nd',
    indexer: 'https://ix/graphql', indexerWs: 'wss://ix/graphql', proofServer: 'http://localhost:6300',
  };

  function fakeModules(calls) {
    return {
      zkConfig: { NodeZkConfigProvider: class { constructor(dir) { calls.zkDir = dir; this.dir = dir; } } },
      indexer: { indexerPublicDataProvider: (...args) => { calls.indexer = args; return { kind: 'public-data' }; } },
      proof: { httpClientProofProvider: (...args) => { calls.proof = args; return { kind: 'proof' }; } },
      privateState: { levelPrivateStateProvider: (cfg) => { calls.privateState = cfg; return { kind: 'private-state' }; } },
    };
  }

  it('wires each provider to the endpoint and directory it belongs to', () => {
    const calls = {};
    const artifacts = inspectArtifacts({ managedDir: fixtureManagedDir() });
    const walletProvider = { getCoinPublicKey: () => 'coin-pk' };
    const providers = buildDeployProviders({
      config, artifacts, modules: fakeModules(calls), walletProvider, privateStatePassword: PASSWORD,
    });

    // zk config reads the same dir inspectArtifacts checked for keys/ and zkir/
    expect(calls.zkDir).toBe(artifacts.managedDir);
    expect(calls.indexer).toEqual([config.indexer, config.indexerWs]);
    expect(calls.proof[0]).toBe(config.proofServer);
    expect(calls.proof[1]).toBe(providers.zkConfigProvider);

    expect(providers.publicDataProvider).toEqual({ kind: 'public-data' });
    expect(providers.proofProvider).toEqual({ kind: 'proof' });
    expect(providers.privateStateProvider).toEqual({ kind: 'private-state' });
    // one object serves as both wallet and submitter, as the two interfaces allow
    expect(providers.walletProvider).toBe(walletProvider);
    expect(providers.midnightProvider).toBe(walletProvider);
  });

  it('scopes the private-state store to the wallet and takes the passphrase from the caller', () => {
    const calls = {};
    const artifacts = inspectArtifacts({ managedDir: fixtureManagedDir() });
    buildDeployProviders({
      config, artifacts, modules: fakeModules(calls),
      walletProvider: { getCoinPublicKey: () => 'coin-pk' }, privateStatePassword: PASSWORD,
    });
    expect(calls.privateState.accountId).toBe(Buffer.from('coin-pk').toString('hex'));
    expect(calls.privateState.privateStoragePasswordProvider()).toBe(PASSWORD);
    // separate stores for state and signing keys, so one cannot clobber the other
    expect(calls.privateState.signingKeyStoreName).not.toBe(calls.privateState.privateStateStoreName);
  });
});

describe('createMidnightProvider - wiring (fake modules; plumbing only, not proof it runs)', () => {
  const config = {
    name: 'preprod', networkId: 'preprod', node: 'https://nd',
    indexer: 'https://ix/graphql', indexerWs: 'wss://ix/graphql',
    proofServer: 'http://localhost:6300', faucet: 'https://faucet.example',
  };
  const env = { [WALLET_SEED_ENV]: SEED, [PRIVATE_STATE_PASSWORD_ENV]: PASSWORD };

  /** Stand-ins for the @midnight-ntwrk modules, recording what they are handed. */
  function harness(overrides = {}) {
    const calls = { networkId: null, deploy: null, compiled: {} };
    const CompiledContract = {
      make: (tag, ctor) => { calls.compiled.tag = tag; calls.compiled.ctor = ctor; return { step: 'made' }; },
      withWitnesses: (self, witnesses) => { calls.compiled.witnesses = witnesses; return { ...self, step: 'witnessed' }; },
      withCompiledFileAssets: (self, dir) => { calls.compiled.assetsPath = dir; return { ...self, step: 'assets' }; },
    };
    const modules = {
      '@midnight-ntwrk/midnight-js-contracts': {
        createUnprovenDeployTx: async (providers, options) => {
          calls.deploy = { providers, options };
          if (overrides.deployError) throw overrides.deployError;
          return overrides.deployed ?? {
            public: { contractAddress: '0200feed', txId: '0xfeed', blockHeight: 77 },
            private: { signingKey: 'SIGNING-KEY-MUST-NOT-LEAK', unprovenTx: 'UNPROVEN' },
          };
        },
        submitTxAsync: async (providers, options) => {
          calls.submitTx = { providers, options };
        },
      },
      '@midnight-ntwrk/midnight-js-indexer-public-data-provider': { indexerPublicDataProvider: () => ({ kind: 'public-data' }) },
      '@midnight-ntwrk/midnight-js-http-client-proof-provider': { httpClientProofProvider: () => ({ kind: 'proof' }) },
      '@midnight-ntwrk/midnight-js-node-zk-config-provider': { NodeZkConfigProvider: class {} },
      '@midnight-ntwrk/midnight-js-level-private-state-provider': { levelPrivateStateProvider: () => ({ kind: 'private-state', setContractAddress: () => {}, set: () => {}, setSigningKey: () => {} }) },
      '@midnight-ntwrk/midnight-js-network-id': { setNetworkId: (id) => { calls.networkId = id; } },
      '@midnight-ntwrk/midnight-js-protocol/compact-js': { CompiledContract },
    };
    const wallet = { getCoinPublicKey: () => 'coin-pk', stopped: 0, stop() { this.stopped += 1; } };
    const deps = {
      resolveModule: async () => true,
      importModule: async (spec) => {
        if (overrides.importError && spec === overrides.importError) throw new Error('Cannot find module');
        if (modules[spec]) return modules[spec];
        if (spec.startsWith('file:')) return { Contract: class NightFleet {} };
        throw new Error(`unexpected import ${spec}`);
      },
      createWalletProvider: async () => wallet,
      fetchImpl: async () => ({ status: 200 }),
    };
    return { calls, deps, wallet };
  }

  it('sets the global network id before anything builds a transaction', async () => {
    const { calls, deps } = harness();
    const provider = await createMidnightProvider(config, env, deps);
    expect(calls.networkId).toBe('preprod');
    expect(provider.name).toContain('midnight-js@');
  });

  it('refuses without the private-state passphrase, with the policy spelled out', async () => {
    const { deps } = harness();
    const err = await createMidnightProvider(config, { [WALLET_SEED_ENV]: SEED }, deps)
      .then(() => null, (e) => e);
    expect(err.code).toBe(EXIT.wallet);
    expect(err.message).toContain('16 characters');
    expect(err.message).not.toContain(SEED);
  });

  it('says which packages are out of line when one will not load', async () => {
    const { deps } = harness({ importError: '@midnight-ntwrk/midnight-js-network-id' });
    const err = await createMidnightProvider(config, env, deps).then(() => null, (e) => e);
    expect(err.code).toBe(EXIT.deploy);
    expect(err.message).toContain('Cannot find module');
    expect(err.message).toContain('npm ls');
  });

  it('probes the three services and reports the wallet alongside them', async () => {
    const { deps } = harness();
    const provider = await createMidnightProvider(config, env, deps);
    const status = await provider.probe();
    expect(Object.keys(status).sort()).toEqual(['indexer', 'node', 'proofServer', 'wallet']);
    expect(status.wallet.ok).toBe(true);
    expect(JSON.stringify(status)).not.toContain(SEED);
  });

  it('binds the compiled contract to the witnesses and the managed dir, then deploys', async () => {
    const { calls, deps } = harness();
    const artifacts = inspectArtifacts({ managedDir: fixtureManagedDir() });
    const provider = await createMidnightProvider(config, env, deps);
    const receipt = await provider.deploy({ config, artifacts });

    expect(calls.compiled.tag).toBe(CONTRACT_TAG);
    expect(typeof calls.compiled.ctor).toBe('function');
    expect(Object.keys(calls.compiled.witnesses).sort()).toEqual(['localSecretKey', 'myBoard', 'mySalt']);
    expect(calls.compiled.assetsPath).toBe(artifacts.managedDir);

    expect(calls.deploy.options.privateStateId).toBe(PRIVATE_STATE_ID);
    expect(calls.deploy.options.initialPrivateState.board).toHaveLength(64);
    expect(calls.deploy.options.compiledContract.step).toBe('assets');
    expect(calls.deploy.providers.walletProvider).toBe(calls.deploy.providers.midnightProvider);

    expect(receipt).toEqual({ contractAddress: '0200feed', txId: '0xfeed', blockHeight: 77 });
  });

  it('never lets the signing key out of deployContract into the receipt', async () => {
    const { deps } = harness();
    const provider = await createMidnightProvider(config, env, deps);
    const receipt = await provider.deploy({
      config, artifacts: inspectArtifacts({ managedDir: fixtureManagedDir() }),
    });
    expect(JSON.stringify(receipt)).not.toContain('SIGNING-KEY-MUST-NOT-LEAK');
  });

  it('turns a node rejection into an actionable DeployError', async () => {
    const deployError = new Error('transaction failed');
    deployError.name = 'DeployTxFailedError';
    deployError.finalizedTxData = { txId: '0xbad' };
    const { deps } = harness({ deployError });
    const provider = await createMidnightProvider(config, env, deps);
    const err = await provider
      .deploy({ config, artifacts: inspectArtifacts({ managedDir: fixtureManagedDir() }) })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect(err.code).toBe(EXIT.deploy);
    expect(err.message).toContain('0xbad');
    expect(err.message).toContain('https://faucet.example');
  });

  it('stops the wallet on close', async () => {
    const { deps, wallet } = harness();
    const provider = await createMidnightProvider(config, env, deps);
    await provider.close();
    expect(wallet.stopped).toBe(1);
  });

  it('is accepted by runDeploy as a provider, end to end through the fakes', async () => {
    const { deps } = harness();
    const io = recorder();
    const outFile = path.join(tmp, 'deployments.json');
    const r = await runDeploy({
      argv: ['--confirm', '--managed', fixtureManagedDir(), '--out', outFile],
      env,
      createProvider: (cfg, e) => createMidnightProvider(cfg, e, deps),
      now: () => 't', ...io,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.record.contractAddress).toBe('0200feed');
    expect(io.text()).not.toContain(SEED);
    expect(io.text()).not.toContain(PASSWORD);
  });
});

describe('createMidnightWalletProvider - wiring (fake wallet SDK; plumbing only)', () => {
  const config = {
    networkId: 'preprod', node: 'https://nd',
    indexer: 'https://ix/graphql', indexerWs: 'wss://ix/graphql', proofServer: 'http://localhost:6300',
  };

  function walletHarness({ seedOk = true } = {}) {
    const calls = { roles: [], facadeInit: null, started: null, balanced: null, signed: 0, finalized: 0, submitted: null, stopped: 0 };
    const facade = {
      start: async (shieldedKeys, dustKey) => { calls.started = { shieldedKeys, dustKey }; },
      stop: async () => { calls.stopped += 1; },
      balanceUnboundTransaction: async (tx, secretKeys, options) => {
        calls.balanced = { tx, secretKeys, options };
        return { type: 'UNBOUND_TRANSACTION', baseTransaction: tx };
      },
      signRecipe: async (recipe, sign) => { calls.signed += 1; calls.signature = sign(new Uint8Array([1])); return { ...recipe, signed: true }; },
      finalizeRecipe: async (recipe) => { calls.finalized += 1; return { finalized: recipe }; },
      submitTransaction: async (tx) => { calls.submitted = tx; return '0xsubmitted'; },
    };
    const walletSdk = {
      Roles: { NightExternal: 0, NightInternal: 1, Dust: 2, Zswap: 3, Metadata: 4 },
      HDWallet: {
        fromSeed: () => (seedOk
          ? {
            type: 'seedOk',
            hdWallet: {
              selectAccount: () => ({
                selectRole: (role) => ({
                  deriveKeyAt: () => { calls.roles.push(role); return { type: 'keyDerived', key: new Uint8Array([role]) }; },
                }),
              }),
            },
          }
          : { type: 'seedError', error: new Error('bad seed') }),
      },
      createKeystore: (secretKey, networkId) => {
        calls.keystore = { secretKey, networkId };
        return { signData: () => 'SIGNATURE' };
      },
      PublicKey: { fromKeyStore: (ks) => ({ fromKeystore: ks }) },
      ShieldedWallet: (cfg) => { calls.shieldedConfig = cfg; return { startWithSeed: (s) => ({ kind: 'shielded', s }) }; },
      UnshieldedWallet: (cfg) => { calls.unshieldedConfig = cfg; return { startWithPublicKey: (pk) => ({ kind: 'unshielded', pk }) }; },
      DustWallet: (cfg) => { calls.dustConfig = cfg; return { startWithSeed: (s, p) => ({ kind: 'dust', s, p }) }; },
      WalletFacade: { init: async (params) => { calls.facadeInit = params; return facade; } },
      InMemoryTransactionHistoryStorage: class { constructor(schema, merge) { this.schema = schema; this.merge = merge; } },
      WalletEntrySchema: { schema: true },
      mergeWalletEntries: () => {},
    };
    const ledger = {
      ZswapSecretKeys: { fromSeed: (s) => ({ coinPublicKey: `coin:${s[0]}`, encryptionPublicKey: `enc:${s[0]}` }) },
      DustSecretKey: { fromSeed: (s) => ({ dust: s[0] }) },
      LedgerParameters: { initialParameters: () => ({ dust: { dustParams: true } }) },
    };
    const deps = {
      importModule: async (spec) => {
        if (spec === '@midnight-ntwrk/wallet-sdk') return walletSdk;
        if (spec === '@midnight-ntwrk/midnight-js-protocol/ledger') return ledger;
        throw new Error(`unexpected import ${spec}`);
      },
    };
    return { calls, deps, facade };
  }

  it('derives one key per role and never carries the seed onto the provider', async () => {
    const { calls, deps } = walletHarness();
    const provider = await createMidnightWalletProvider(config, { [WALLET_SEED_ENV]: HEX_SEED }, deps);
    // Zswap (3) for shielded, NightExternal (0) for unshielded, Dust (2) for dust
    expect(calls.roles).toEqual([3, 0, 2]);
    expect(JSON.stringify(Object.keys(provider))).not.toContain(HEX_SEED);
    expect(provider.getCoinPublicKey()).toBe('coin:3');
    expect(provider.getEncryptionPublicKey()).toBe('enc:3');
  });

  it('configures all three sub-wallets against the same endpoints', async () => {
    const { calls, deps } = walletHarness();
    await createMidnightWalletProvider(config, { [WALLET_SEED_ENV]: HEX_SEED }, deps);
    expect(calls.shieldedConfig.indexerClientConnection).toEqual({
      indexerHttpUrl: config.indexer, indexerWsUrl: config.indexerWs,
    });
    expect(calls.shieldedConfig.networkId).toBe('preprod');
    expect(String(calls.shieldedConfig.provingServerUrl)).toContain('6300');
    // the node relay is a WebSocket, derived from the RPC url
    expect(String(calls.shieldedConfig.relayURL)).toBe('wss://nd/');
    // dust is the only one that needs cost parameters
    expect(calls.dustConfig.costParameters).toMatchObject({ additionalFeeOverhead: 0n, feeBlocksMargin: 5 });
    expect(calls.keystore.networkId).toBe('preprod');
  });

  it('starts the facade with the shielded and dust secret keys', async () => {
    const { calls, deps } = walletHarness();
    await createMidnightWalletProvider(config, { [WALLET_SEED_ENV]: HEX_SEED }, deps);
    expect(calls.facadeInit.configuration.networkId).toBe('preprod');
    expect(calls.facadeInit.shielded()).toMatchObject({ kind: 'shielded' });
    expect(calls.facadeInit.unshielded()).toMatchObject({ kind: 'unshielded' });
    expect(calls.facadeInit.dust()).toMatchObject({ kind: 'dust' });
    expect(calls.started.shieldedKeys.coinPublicKey).toBe('coin:3');
    expect(calls.started.dustKey).toEqual({ dust: 2 });
  });

  it('balances, signs and finalizes in that order, with a ttl', async () => {
    const { calls, deps } = walletHarness();
    const provider = await createMidnightWalletProvider(config, { [WALLET_SEED_ENV]: HEX_SEED }, deps);
    const out = await provider.balanceTx({ unbound: true });
    expect(calls.balanced.tx).toEqual({ unbound: true });
    expect(calls.balanced.options.ttl).toBeInstanceOf(Date);
    expect(calls.balanced.secretKeys.shieldedSecretKeys.coinPublicKey).toBe('coin:3');
    expect(calls.signed).toBe(1);
    expect(calls.signature).toBe('SIGNATURE');
    expect(calls.finalized).toBe(1);
    expect(out.finalized.signed).toBe(true);
  });

  it('honours a caller-supplied ttl', async () => {
    const { calls, deps } = walletHarness();
    const provider = await createMidnightWalletProvider(config, { [WALLET_SEED_ENV]: HEX_SEED }, deps);
    const ttl = new Date('2027-01-01T00:00:00.000Z');
    await provider.balanceTx({}, ttl);
    expect(calls.balanced.options.ttl).toBe(ttl);
  });

  it('submits through the facade and closes it', async () => {
    const { calls, deps } = walletHarness();
    const provider = await createMidnightWalletProvider(config, { [WALLET_SEED_ENV]: HEX_SEED }, deps);
    expect(await provider.submitTx({ tx: 1 })).toBe('0xsubmitted');
    expect(calls.submitted).toEqual({ tx: 1 });
    await provider.stop();
    expect(calls.stopped).toBe(1);
  });

  it('rejects an unusable seed without printing it', async () => {
    const { deps } = walletHarness({ seedOk: false });
    const err = await createMidnightWalletProvider(config, { [WALLET_SEED_ENV]: HEX_SEED }, deps)
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect(err.code).toBe(EXIT.wallet);
    expect(err.message).toContain(WALLET_SEED_ENV);
    expect(err.message).not.toContain(HEX_SEED);
  });
});
