// The signing surface handed to the deploy/game layer, and the privacy rules
// around it: nothing beyond sign/balance/submit/prove, and no secret material
// in any return value, snapshot, or log line.
import { describe, it, expect } from 'vitest';
import { createLaceConnector } from '../src/connector.js';
import { WalletErrorCode } from '../src/errors.js';
import {
  makeLaceV4, makeWindow, emptyWindow, FAKE_SHIELDED_ADDRESS,
} from './mock-provider.js';

const connect = (win, opts = {}) => createLaceConnector({
  window: win, watchIntervalMs: 0, timeoutMs: 1_000, ...opts,
});

describe('getSigner()', () => {
  it('throws NOT_CONNECTED before a connection exists', () => {
    expect(() => connect(emptyWindow()).getSigner())
      .toThrowError(expect.objectContaining({ code: WalletErrorCode.NOT_CONNECTED }));
  });

  it('throws NOT_CONNECTED after a wrong-network refusal', async () => {
    const c = connect(makeWindow(makeLaceV4({ networkId: 'mainnet' })));
    await c.connect();
    expect(() => c.getSigner())
      .toThrowError(expect.objectContaining({ code: WalletErrorCode.NOT_CONNECTED }));
  });

  it('throws NOT_CONNECTED again after disconnect()', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    await c.connect();
    expect(c.getSigner()).toBeTruthy();
    c.disconnect();
    expect(() => c.getSigner()).toThrow();
  });

  it('exposes exactly the methods the game needs and nothing more', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    await c.connect();
    expect(Object.keys(c.getSigner()).sort()).toEqual([
      'balanceTransaction', 'capabilities', 'getProvingProvider',
      'getServiceConfig', 'networkId', 'signData', 'submitTransaction',
    ]);
  });

  it('does NOT forward balances, dust or transaction history', async () => {
    const lace = makeLaceV4();
    const c = connect(makeWindow(lace));
    await c.connect();
    const signer = c.getSigner();
    for (const forbidden of [
      'getShieldedBalances', 'getUnshieldedBalances', 'getDustBalance',
      'getTxHistory', 'getShieldedAddresses', 'getUnshieldedAddress', 'makeTransfer',
    ]) {
      expect(signer[forbidden]).toBeUndefined();
    }
    expect(lace.state.calls).not.toContain('getShieldedBalances');
    expect(lace.state.calls).not.toContain('getTxHistory');
  });

  it('is frozen, so the game layer cannot graft extra powers onto it', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    await c.connect();
    expect(Object.isFrozen(c.getSigner())).toBe(true);
  });

  it('balances a contract call as an UNSEALED transaction by default', async () => {
    const lace = makeLaceV4();
    const c = connect(makeWindow(lace));
    await c.connect();
    expect(await c.getSigner().balanceTransaction('tx1')).toEqual({ tx: 'balanced-unsealed:tx1' });
    expect(lace.state.calls).toContain('balanceUnsealedTransaction');
  });

  it('can opt into the sealed path for a wallet-created transaction', async () => {
    const lace = makeLaceV4();
    const c = connect(makeWindow(lace));
    await c.connect();
    expect(await c.getSigner().balanceTransaction('tx2', { sealed: true }))
      .toEqual({ tx: 'balanced-sealed:tx2' });
  });

  it('submits and signs through the wallet', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    await c.connect();
    const signer = c.getSigner();
    expect(await signer.submitTransaction('tx3')).toBe('txid:tx3');
    const sig = await signer.signData('deadbeef', { encoding: 'hex', keyType: 'unshielded' });
    expect(sig).toMatchObject({ signature: 'sig-mock', verifyingKey: 'vk-mock' });
  });

  it('hands back the wallet proving provider (HTTP-proof fallback)', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    await c.connect();
    const pp = await c.getSigner().getProvingProvider({ getZKIR: async () => new Uint8Array() });
    expect(typeof pp.prove).toBe('function');
    expect(typeof pp.check).toBe('function');
  });

  it('reports which capabilities the connected wallet actually has', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    await c.connect();
    expect(c.getSigner().capabilities).toMatchObject({
      signData: true, balanceTransaction: true, submitTransaction: true, provingProvider: true,
    });
  });

  it('rejects with UNSUPPORTED_OPERATION when the wallet lacks a method', async () => {
    const c = connect(makeWindow(makeLaceV4({ omit: ['signData', 'getProvingProvider'] })));
    await c.connect();
    const signer = c.getSigner();
    expect(signer.capabilities.signData).toBe(false);
    await expect(signer.signData('x', {}))
      .rejects.toMatchObject({ code: WalletErrorCode.UNSUPPORTED_OPERATION });
    await expect(signer.getProvingProvider({}))
      .rejects.toMatchObject({ code: WalletErrorCode.UNSUPPORTED_OPERATION });
  });

  it('surfaces a mid-call disconnect as DISCONNECTED', async () => {
    const lace = makeLaceV4();
    const c = connect(makeWindow(lace));
    await c.connect();
    lace.dropConnection();
    await expect(c.getSigner().submitTransaction('tx4'))
      .rejects.toMatchObject({ code: WalletErrorCode.DISCONNECTED });
  });
});

describe('address handling', () => {
  it('the snapshot carries only a redacted address', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    const s = await c.connect();
    expect(s.address).toContain('…');
    expect(s.address).not.toBe(FAKE_SHIELDED_ADDRESS);
  });

  it('revealAddress() is the only way to the raw value, and needs a connection', async () => {
    const c = connect(makeWindow(makeLaceV4()));
    await expect(c.revealAddress())
      .rejects.toMatchObject({ code: WalletErrorCode.NOT_CONNECTED });
    await c.connect();
    expect(await c.revealAddress()).toBe(FAKE_SHIELDED_ADDRESS);
    c.disconnect();
    await expect(c.revealAddress()).rejects.toMatchObject({
      code: WalletErrorCode.NOT_CONNECTED,
    });
  });

  it('the redaction window is configurable', async () => {
    const c = connect(makeWindow(makeLaceV4()), { redaction: { lead: 4, tail: 4 } });
    const s = await c.connect();
    expect(s.address).toBe(
      `${FAKE_SHIELDED_ADDRESS.slice(0, 4)}…${FAKE_SHIELDED_ADDRESS.slice(-4)}`,
    );
  });
});

describe('logging never leaks', () => {
  it('no log line contains the address, on success or on failure', async () => {
    const lines = [];
    const logger = (event, data) => lines.push(`${event} ${JSON.stringify(data)}`);

    const ok = connect(makeWindow(makeLaceV4()), { logger });
    await ok.connect();
    ok.disconnect();

    const bad = connect(makeWindow(makeLaceV4({ networkId: 'mainnet' })), { logger });
    await bad.connect();

    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join('\n');
    expect(joined).not.toContain(FAKE_SHIELDED_ADDRESS);
    for (const needle of ['seed', 'mnemonic', 'privateKey', 'secretKey']) {
      expect(joined.toLowerCase()).not.toContain(needle.toLowerCase());
    }
  });

  it('a throwing logger cannot fail a connection', async () => {
    const c = connect(makeWindow(makeLaceV4()), {
      logger: () => { throw new Error('logger exploded'); },
    });
    expect((await c.connect()).status).toBe('connected');
  });

  it('WalletError.toJSON() carries no wallet-supplied text', async () => {
    const secretish = `locked with key ${FAKE_SHIELDED_ADDRESS}`;
    const lace = makeLaceV4({
      connectError: Object.assign(new Error(secretish), {
        type: 'DAppConnectorAPIError', code: 'Rejected', reason: secretish,
      }),
    });
    const s = await connect(makeWindow(lace)).connect();
    expect(JSON.stringify(s.error)).not.toContain(FAKE_SHIELDED_ADDRESS);
    expect(s.error.code).toBe(WalletErrorCode.WALLET_LOCKED);
  });
});
