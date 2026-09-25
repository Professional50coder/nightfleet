// The legacy DApp connector API 3.x path. We cannot know which major a given
// Lace build injects, so the package drives both; these tests pin the
// differences the frontend needs to know about (no signData, no proving
// provider, no network id - hence no connection without allowInferredNetwork).
import { describe, it, expect } from 'vitest';
import { createLaceConnector } from '../src/connector.js';
import { WalletStatus } from '../src/state.js';
import { WalletErrorCode } from '../src/errors.js';
import { makeLaceV3, makeWindow, connectorError, FAKE_SHIELDED_ADDRESS } from './mock-provider.js';

const connect = (win, opts = {}) => createLaceConnector({
  window: win, watchIntervalMs: 0, timeoutMs: 1_000, ...opts,
});

describe('connector API 3.x', () => {
  it('detects as available with flavor v3', () => {
    const s = connect(makeWindow(makeLaceV3())).detect();
    expect(s.status).toBe(WalletStatus.AVAILABLE);
    expect(s.wallet.flavor).toBe('v3');
    expect(s.wallet.apiVersion).toBe('3.0.0');
  });

  it('refuses to connect by default, because 3.x reports no network id', async () => {
    const s = await connect(makeWindow(makeLaceV3())).connect();
    expect(s.status).toBe(WalletStatus.ERROR);
    expect(s.error.code).toBe(WalletErrorCode.NETWORK_UNVERIFIED);
  });

  it('connects when the caller opts into the URI-based inference', async () => {
    const c = connect(makeWindow(makeLaceV3()), { allowInferredNetwork: true });
    const s = await c.connect();
    expect(s.status).toBe(WalletStatus.CONNECTED);
    expect(s.networkId).toBe('preprod');
    expect(s.networkInferred).toBe(true);
  });

  it('still refuses when the inferred network is mainnet', async () => {
    const lace = makeLaceV3({
      serviceConfig: {
        indexerUri: 'https://indexer.mainnet.midnight.network/api/v4/graphql',
        substrateNodeUri: 'wss://rpc.mainnet.midnight.network',
      },
    });
    const s = await connect(makeWindow(lace), { allowInferredNetwork: true }).connect();
    expect(s.error.code).toBe(WalletErrorCode.MAINNET_REFUSED);
  });

  it('reads the address from state() and redacts it', async () => {
    const c = connect(makeWindow(makeLaceV3()), { allowInferredNetwork: true });
    const s = await c.connect();
    expect(s.address).not.toBe(FAKE_SHIELDED_ADDRESS);
    expect(await c.revealAddress()).toBe(FAKE_SHIELDED_ADDRESS);
  });

  it('reports the reduced capability set honestly', async () => {
    const c = connect(makeWindow(makeLaceV3()), { allowInferredNetwork: true });
    await c.connect();
    expect(c.getSigner().capabilities).toMatchObject({
      signData: false, provingProvider: false,
      balanceTransaction: true, submitTransaction: true,
    });
  });

  it('rejects signData and getProvingProvider with UNSUPPORTED_OPERATION', async () => {
    const c = connect(makeWindow(makeLaceV3()), { allowInferredNetwork: true });
    await c.connect();
    const signer = c.getSigner();
    await expect(signer.signData('x', {}))
      .rejects.toMatchObject({ code: WalletErrorCode.UNSUPPORTED_OPERATION });
    await expect(signer.getProvingProvider({}))
      .rejects.toMatchObject({ code: WalletErrorCode.UNSUPPORTED_OPERATION });
  });

  it('maps balanceTransaction onto balanceAndProveTransaction', async () => {
    const lace = makeLaceV3();
    const c = connect(makeWindow(lace), { allowInferredNetwork: true });
    await c.connect();
    expect(await c.getSigner().balanceTransaction('tx1', { newCoins: ['c'] }))
      .toEqual({ tx: 'balanced-proven:tx1', newCoins: ['c'] });
    expect(lace.state.calls).toContain('balanceAndProveTransaction');
  });

  it('maps a rejected enable() onto USER_REJECTED', async () => {
    const lace = makeLaceV3({ enableError: connectorError('Rejected', 'user said no') });
    const s = await connect(makeWindow(lace), { allowInferredNetwork: true }).connect();
    expect(s.error.code).toBe(WalletErrorCode.USER_REJECTED);
  });

  it('treats isEnabled() going false as a mid-session disconnect', async () => {
    const lace = makeLaceV3();
    const c = connect(makeWindow(lace), { allowInferredNetwork: true });
    await c.connect();
    lace.disable();
    const s = await c.checkConnection();
    expect(s.status).toBe(WalletStatus.ERROR);
    expect(s.error.code).toBe(WalletErrorCode.DISCONNECTED);
  });
});
