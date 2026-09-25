// Wallet material is radioactive. These tests
// pin the two rules that matter - a display string can never reconstruct the
// address, and nothing secret-shaped survives a trip to a logger.
import { describe, it, expect } from 'vitest';
import { redactAddress, redactHash, scrubForLog, isRedacted, REDACTION } from '../src/redact.js';
import { FAKE_SHIELDED_ADDRESS } from './mock-provider.js';

describe('redactAddress', () => {
  it('keeps a recognisable head and tail and drops the middle', () => {
    const out = redactAddress(FAKE_SHIELDED_ADDRESS);
    expect(out.startsWith(FAKE_SHIELDED_ADDRESS.slice(0, REDACTION.lead))).toBe(true);
    expect(out.endsWith(FAKE_SHIELDED_ADDRESS.slice(-REDACTION.tail))).toBe(true);
    expect(out).toContain(REDACTION.ellipsis);
  });

  it('is strictly shorter than the address, so it cannot be pasted as one', () => {
    const out = redactAddress(FAKE_SHIELDED_ADDRESS);
    expect(out.length).toBeLessThan(FAKE_SHIELDED_ADDRESS.length);
    expect(FAKE_SHIELDED_ADDRESS.includes(out)).toBe(false);
  });

  it('honours a custom window', () => {
    expect(redactAddress(FAKE_SHIELDED_ADDRESS, { lead: 4, tail: 4, ellipsis: '...' }))
      .toBe(`${FAKE_SHIELDED_ADDRESS.slice(0, 4)}...${FAKE_SHIELDED_ADDRESS.slice(-4)}`);
  });

  it('redacts a short value wholesale rather than revealing most of it', () => {
    expect(redactAddress('abc')).toBe(REDACTION.ellipsis);
    expect(redactAddress('a'.repeat(REDACTION.lead + REDACTION.tail))).toBe(REDACTION.ellipsis);
  });

  it('returns an empty string for a non-string or empty input', () => {
    for (const v of ['', null, undefined, 42, {}]) expect(redactAddress(v)).toBe('');
  });

  it('redactHash uses a tighter window suited to tx ids', () => {
    const hash = 'a'.repeat(64);
    expect(redactHash(hash).length).toBeLessThan(hash.length);
  });
});

describe('scrubForLog', () => {
  it('drops every secret-shaped key', () => {
    const out = scrubForLog({
      seed: 'abandon abandon abandon', mnemonic: 'x', privateKey: 'y', secretKey: 'z',
      passphrase: 'p', apiToken: 't', signingKey: 's', password: 'pw', safe: 'keep me',
    });
    for (const k of ['seed', 'mnemonic', 'privateKey', 'secretKey', 'passphrase', 'apiToken', 'signingKey', 'password']) {
      expect(out[k]).toBe('[redacted]');
    }
    expect(out.safe).toBe('keep me');
  });

  it('redacts an address embedded in free text', () => {
    const out = scrubForLog(`connected as ${FAKE_SHIELDED_ADDRESS} on preprod`);
    expect(out).not.toContain(FAKE_SHIELDED_ADDRESS);
    expect(out).toContain('preprod');
  });

  it('redacts addresses nested in objects and arrays', () => {
    const out = scrubForLog({ a: [{ addr: FAKE_SHIELDED_ADDRESS }] });
    expect(JSON.stringify(out)).not.toContain(FAKE_SHIELDED_ADDRESS);
  });

  it('flattens errors to name/code/message and bigints to strings', () => {
    const e = Object.assign(new Error('nope'), { code: 'X' });
    expect(scrubForLog({ e })).toEqual({ e: { name: 'Error', code: 'X', message: 'nope' } });
    expect(scrubForLog({ n: 10n })).toEqual({ n: '10n' });
    expect(scrubForLog({ f: () => {} })).toEqual({ f: '[fn]' });
  });

  it('stops recursing rather than looping forever on a cycle', () => {
    const a = { name: 'a' };
    a.self = a;
    expect(() => scrubForLog(a)).not.toThrow();
  });

  it('leaves ordinary values alone', () => {
    expect(scrubForLog({ status: 'connected', networkId: 'preprod', n: 3, ok: true }))
      .toEqual({ status: 'connected', networkId: 'preprod', n: 3, ok: true });
    expect(scrubForLog(null)).toBeNull();
  });
});

describe('isRedacted', () => {
  it('is false for a raw address and true for its redaction', () => {
    expect(isRedacted(FAKE_SHIELDED_ADDRESS)).toBe(false);
    expect(isRedacted(redactAddress(FAKE_SHIELDED_ADDRESS))).toBe(true);
    expect(isRedacted('preprod')).toBe(true);
  });
});
