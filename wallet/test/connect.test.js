// The connect lifecycle against a mock injected provider, one test per
// documented failure mode. Every one of these has killed a live demo for
// somebody; none of them may end in a silent success.
import { describe, it, expect } from 'vitest';
import { createLaceConnector } from '../src/connector.js';
import { WalletStatus } from '../src/state.js';
import { WalletErrorCode } from '../src/errors.js';
import {
  makeLaceV4, makeWindow, emptyWindow, connectorError, FAKE_SHIELDED_ADDRESS,
} from './mock-provider.js';

/** Timers off by default: these tests drive liveness through checkConnection(). */
const connect = (win, opts = {}) => createLaceConnector({
  window: win, watchIntervalMs: 0, timeoutMs: 1_000, ...opts,
});

describe('detect()', () => {
  it('is unavailable with no extension installed', () => {
    const c = connect(emptyWindow());
    expect(c.getSnapshot().status).toBe(WalletStatus.UNAVAILABLE);
    expect(c.detect().status).toBe(WalletStatus.UNAVAILABLE);
    expect(c.getSnapshot().wallet).toBeNull();
    expect(c.getSnapshot().error).toBeNull();
  });

  it('is available - not connected - once a supported wallet is injected', () => {
    const s = connect(makeWindow(makeLaceV4())).detect();
    expect(s.status).toBe(WalletStatus.AVAILABLE);
    expect(s.wallet).toMatchObject({ key: 'mnLace', isLace: true, apiVersion: '4.0.1' });
    expect(s.address).toBeNull();
    expect(s.networkVerified).toBe(false);
  });

  it('reports a version mismatch as unavailable WITH an explanatory code', () => {
    const s = connect(makeWindow(makeLaceV4({ apiVersion: '99.0.0' }))).detect();
    expect(s.status).toBe(WalletStatus.UNAVAILABLE);
    expect(s.error.code).toBe(WalletErrorCode.UNSUPPORTED_API_VERSION);
    expect(s.error.retryable).toBe(false);
  });

  it('picks up a wallet injected after the first detect()', () => {
    const win = emptyWindow();
    const c = connect(win);
    expect(c.detect().status).toBe(WalletStatus.UNAVAILABLE);
    Object.assign(win, makeWindow(makeLaceV4()));
    expect(c.detect().status).toBe(WalletStatus.AVAILABLE);
  });

  it('returns the identical snapshot object when nothing changed', () => {
    const c = connect(makeWindow(makeLaceV4()));
    expect(c.detect()).toBe(c.detect());
  });
});

describe('connect() happy path', () => {
  it('reaches connected with a verified Preprod network', async () => {
    const lace = makeLaceV4();
    const c = connect(makeWindow(lace));
    const s = await c.connect();
    expect(s.status).toBe(WalletStatus.CONNECTED);
    expect(s.networkId).toBe('preprod');
    expect(s.networkVerified).toBe(true);
    expect(s.networkInferred).toBe(false);
    expect(s.error).toBeNull();
    expect(typeof s.connectedAt).toBe('number');
  });

  it('passes the expected network id to connect() as a hint', async () => {
    const lace = makeLaceV4();
    await connect(makeWindow(lace)).connect();
    expect(lace.state.calls).toContain('connect:preprod');
  });

  it('hints the methods it will use so the wallet can batch its prompts', async () => {
    const lace = makeLaceV4();
    await connect(makeWindow(lace)).connect();
    const hint = lace.state.calls.find((m) => m.startsWith('hintUsage:'));
    expect(hint).toBeDefined();
    expect(hint).toContain('submitTransaction');
    expect(hint).toContain('getProvingProvider');
  });

  it('walks unavailable -> available -> connecting -> connected in order', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    const seen = [];
    c.subscribe((s) => seen.push(s.status));
    await c.connect();
    expect(seen).toEqual(['available', 'connecting', 'connected']);
  });

  it('shares one attempt between concurrent callers', async () => {
    const lace = makeLaceV4({ connectDelayMs: 10 });
    const c = connect(makeWindow(lace));
    const [a, b] = await Promise.all([c.connect(), c.connect()]);
    expect(a).toBe(b);
    expect(lace.state.calls.filter((m) => m.startsWith('connect:'))).toHaveLength(1);
  });

  it('is a no-op once connected', async () => {
    const lace = makeLaceV4();
    const c = connect(makeWindow(lace));
    const first = await c.connect();
    expect(await c.connect()).toBe(first);
    expect(lace.state.calls.filter((m) => m.startsWith('connect:'))).toHaveLength(1);
  });

  it('can display the unshielded address instead when asked', async () => {
    const lace = makeLaceV4();
    const c = connect(makeWindow(lace), { addressKind: 'unshielded' });
    await c.connect();
    expect(lace.state.calls).toContain('getUnshieldedAddress');
    expect(lace.state.calls).not.toContain('getShieldedAddresses');
  });
});

describe('connect() failure modes', () => {
  it('extension not installed -> error NO_PROVIDER, never a throw', async () => {
    const c = connect(emptyWindow());
    const s = await c.connect();
    expect(s.status).toBe(WalletStatus.ERROR);
    expect(s.error.code).toBe(WalletErrorCode.NO_PROVIDER);
    expect(s.error.retryable).toBe(true);
    expect(s.error.action).toMatch(/install/i);
  });

  it('user rejects the prompt -> USER_REJECTED', async () => {
    const lace = makeLaceV4({ connectError: connectorError('Rejected', 'user declined') });
    const s = await connect(makeWindow(lace)).connect();
    expect(s.status).toBe(WalletStatus.ERROR);
    expect(s.error.code).toBe(WalletErrorCode.USER_REJECTED);
    expect(s.error.retryable).toBe(true);
  });

  it('permission refused -> PERMISSION_DENIED', async () => {
    const lace = makeLaceV4({
      connectError: connectorError('PermissionRejected', 'site not allowed'),
    });
    const s = await connect(makeWindow(lace)).connect();
    expect(s.error.code).toBe(WalletErrorCode.PERMISSION_DENIED);
  });

  it('wallet locked -> WALLET_LOCKED, told apart from a plain rejection', async () => {
    const lace = makeLaceV4({ connectError: connectorError('Rejected', 'wallet is locked') });
    const s = await connect(makeWindow(lace)).connect();
    expect(s.error.code).toBe(WalletErrorCode.WALLET_LOCKED);
    expect(s.error.action).toMatch(/unlock/i);
  });

  it('wallet on preview instead of preprod -> WRONG_NETWORK, not connected', async () => {
    const lace = makeLaceV4({ networkId: 'preview' });
    const s = await connect(makeWindow(lace)).connect();
    expect(s.status).toBe(WalletStatus.ERROR);
    expect(s.error.code).toBe(WalletErrorCode.WRONG_NETWORK);
    expect(s.networkId).toBe('preview');
    expect(s.networkVerified).toBe(false);
    expect(s.address).toBeNull();
  });

  it('wallet on mainnet -> MAINNET_REFUSED with its own copy', async () => {
    const lace = makeLaceV4({ networkId: 'mainnet' });
    const s = await connect(makeWindow(lace)).connect();
    expect(s.error.code).toBe(WalletErrorCode.MAINNET_REFUSED);
    expect(s.error.userMessage).toMatch(/mainnet/i);
  });

  it('a wallet that hides its network fails closed, it does not pass', async () => {
    const lace = makeLaceV4({
      omit: ['getConnectionStatus'],
      reportNetworkIdInConfig: false,
      serviceConfig: { indexerUri: 'https://example.com/graphql' },
    });
    const s = await connect(makeWindow(lace)).connect();
    expect(s.status).toBe(WalletStatus.ERROR);
    expect(s.error.code).toBe(WalletErrorCode.NETWORK_UNVERIFIED);
  });

  it('an INFERRED preprod is refused by default and accepted only on request', async () => {
    const opts = {
      omit: ['getConnectionStatus'],
      reportNetworkIdInConfig: false,
      serviceConfig: { indexerUri: 'https://indexer.preprod.midnight.network/api/v4/graphql' },
    };
    const refused = await connect(makeWindow(makeLaceV4(opts))).connect();
    expect(refused.error.code).toBe(WalletErrorCode.NETWORK_UNVERIFIED);
    expect(refused.networkId).toBe('preprod'); // shown, but not trusted

    const allowed = await connect(makeWindow(makeLaceV4(opts)), { allowInferredNetwork: true })
      .connect();
    expect(allowed.status).toBe(WalletStatus.CONNECTED);
    expect(allowed.networkInferred).toBe(true);
  });

  it('version mismatch at connect time -> UNSUPPORTED_API_VERSION', async () => {
    const s = await connect(makeWindow(makeLaceV4({ apiVersion: '99.0.0' }))).connect();
    expect(s.error.code).toBe(WalletErrorCode.UNSUPPORTED_API_VERSION);
    expect(s.error.retryable).toBe(false);
  });

  it('a wallet that never answers -> TIMEOUT rather than a stuck spinner', async () => {
    const lace = makeLaceV4({ connectDelayMs: 200 });
    const s = await connect(makeWindow(lace), { timeoutMs: 20 }).connect();
    expect(s.status).toBe(WalletStatus.ERROR);
    expect(s.error.code).toBe(WalletErrorCode.TIMEOUT);
  });

  it('a wallet that resolves connect() with junk -> INTERNAL_ERROR', async () => {
    const lace = makeLaceV4({ connectResolvesWith: null });
    const s = await connect(makeWindow(lace)).connect();
    expect(s.error.code).toBe(WalletErrorCode.INTERNAL_ERROR);
  });

  it('an internal wallet error keeps its own code', async () => {
    const lace = makeLaceV4({ connectError: connectorError('InternalError', 'boom') });
    expect((await connect(makeWindow(lace)).connect()).error.code)
      .toBe(WalletErrorCode.INTERNAL_ERROR);
  });

  it('a non-connector throw still lands as a WalletError, never as a crash', async () => {
    const lace = makeLaceV4({ connectError: new TypeError('undefined is not a function') });
    const s = await connect(makeWindow(lace)).connect();
    expect(s.status).toBe(WalletStatus.ERROR);
    expect(s.error.code).toBe(WalletErrorCode.INTERNAL_ERROR);
  });

  it('retries from the error state', async () => {
    const win = makeWindow(makeLaceV4({ connectError: connectorError('Rejected', 'no') }));
    const c = connect(win);
    expect((await c.connect()).status).toBe(WalletStatus.ERROR);
    Object.assign(win, makeWindow(makeLaceV4()));
    expect((await c.connect()).status).toBe(WalletStatus.CONNECTED);
  });

  it('clearError() returns to available without reconnecting', async () => {
    const lace = makeLaceV4({ connectError: connectorError('Rejected', 'no') });
    const c = connect(makeWindow(lace));
    expect((await c.connect()).status).toBe(WalletStatus.ERROR);
    const cleared = c.clearError();
    // The provider is still injected and supported, so we fall back to
    // `available` - the user can press Connect again.
    expect(cleared.status).toBe(WalletStatus.AVAILABLE);
    expect(cleared.error).toBeNull();
    expect(lace.state.calls.filter((m) => m.startsWith('connect:'))).toHaveLength(1);
  });

  it('clearError() is a no-op outside the error state', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    const s = c.detect();
    expect(c.clearError()).toBe(s);
  });
});

describe('disconnect and mid-session loss', () => {
  it('disconnect() drops to available and clears everything session-scoped', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    await c.connect();
    const s = c.disconnect();
    expect(s.status).toBe(WalletStatus.AVAILABLE);
    expect(s.address).toBeNull();
    expect(s.networkId).toBeNull();
    expect(s.networkVerified).toBe(false);
    expect(s.capabilities).toBeNull();
    expect(s.connectedAt).toBeNull();
    expect(s.error).toBeNull();
  });

  it('disconnect() drops to unavailable when the extension is gone too', async () => {
    const win = makeWindow(makeLaceV4());
    const c = connect(win);
    await c.connect();
    delete win.midnight.mnLace;
    expect(c.disconnect().status).toBe(WalletStatus.UNAVAILABLE);
  });

  it('a wallet that drops us mid-session -> error DISCONNECTED', async () => {
    const lace = makeLaceV4();
    const c = connect(makeWindow(lace));
    await c.connect();
    lace.dropConnection();
    const s = await c.checkConnection();
    expect(s.status).toBe(WalletStatus.ERROR);
    expect(s.error.code).toBe(WalletErrorCode.DISCONNECTED);
    expect(s.address).toBeNull();
    expect(s.networkVerified).toBe(false);
  });

  it('the extension being removed mid-session -> unavailable, NO_PROVIDER', async () => {
    const win = makeWindow(makeLaceV4());
    const c = connect(win);
    await c.connect();
    delete win.midnight.mnLace;
    const s = await c.checkConnection();
    expect(s.status).toBe(WalletStatus.UNAVAILABLE);
    expect(s.error.code).toBe(WalletErrorCode.NO_PROVIDER);
  });

  it('checkConnection() is a no-op when not connected', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    const before = c.detect();
    expect(await c.checkConnection()).toBe(before);
  });

  it('polls on an interval when one is configured, and stops on destroy', async () => {
    const lace = makeLaceV4();
    const c = createLaceConnector({ window: makeWindow(lace), watchIntervalMs: 5, timeoutMs: 500 });
    await c.connect();
    lace.dropConnection();
    await new Promise((r) => { setTimeout(r, 60); });
    expect(c.getSnapshot().error?.code).toBe(WalletErrorCode.DISCONNECTED);
    c.destroy();
  });
});

describe('subscribers', () => {
  it('receives every change and can unsubscribe', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    const seen = [];
    const off = c.subscribe((s) => seen.push(s.status));
    await c.connect();
    off();
    c.disconnect();
    expect(seen).toEqual(['available', 'connecting', 'connected']);
  });

  it('a throwing subscriber cannot break the state machine', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    c.subscribe(() => { throw new Error('bad listener'); });
    const s = await c.connect();
    expect(s.status).toBe(WalletStatus.CONNECTED);
  });

  it('rejects a non-function listener', () => {
    expect(() => connect(emptyWindow()).subscribe('nope')).toThrow(TypeError);
  });

  it('listWallets() describes every injection without exposing the raw provider', () => {
    const c = connect(makeWindow(makeLaceV4()));
    const [w] = c.listWallets();
    expect(w.key).toBe('mnLace');
    expect(w.provider).toBeUndefined();
  });
});

describe('configuration guards', () => {
  it('refuses to be constructed against mainnet', () => {
    expect(() => connect(emptyWindow(), { expectedNetworkId: 'mainnet' }))
      .toThrow(/refuses to target mainnet/);
  });

  it('can be pointed at the local undeployed stack', async () => {
    const lace = makeLaceV4({ networkId: 'undeployed' });
    const s = await connect(makeWindow(lace), { expectedNetworkId: 'undeployed' }).connect();
    expect(s.status).toBe(WalletStatus.CONNECTED);
    expect(s.networkId).toBe('undeployed');
  });

  it('after destroy(), connect() and detect() are inert', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    c.destroy();
    expect((await c.connect()).status).toBe(WalletStatus.UNAVAILABLE);
    expect(c.detect().status).toBe(WalletStatus.UNAVAILABLE);
  });

  it('never writes the raw address into a snapshot', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    const s = await c.connect();
    expect(JSON.stringify(s)).not.toContain(FAKE_SHIELDED_ADDRESS);
    expect(s.address).not.toBe(FAKE_SHIELDED_ADDRESS);
    expect(s.address.length).toBeLessThan(FAKE_SHIELDED_ADDRESS.length);
  });
});
