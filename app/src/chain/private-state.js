// localStorage-backed PrivateStateProvider for the browser.
//
// midnight-js's PrivateStateProvider interface, scoped per contract address:
// setContractAddress(address) first, then get/set/remove by private-state id,
// plus the contract-maintenance signing key slots.
//
// Honest security note: localStorage is NOT encrypted. The Node levelDB
// provider encrypts at rest behind a passphrase; the browser has no
// equivalent, so a player's fleet, salt and secret key sit in the origin's
// storage readable by any script running on this origin. That matches how
// browser DApps on Midnight hold session state today (the wallet itself keeps
// the money keys), but it is a weaker boundary than the CLI's - do not reuse
// this provider for anything beyond game secrets, and never copy these values
// into logs, URLs, or error reports.

import { encodeState, decodeState } from './codec.js';

const STATE_PREFIX = 'nightfleet:ps:';
const KEY_PREFIX = 'nightfleet:signing:';

export class BrowserPrivateStateProvider {
  /** @param {Storage} [storage] injectable for tests */
  constructor(storage = globalThis.localStorage) {
    if (!storage) throw new Error('BrowserPrivateStateProvider needs Web Storage');
    this.storage = storage;
    this.contractAddress = null;
  }

  setContractAddress(address) {
    this.contractAddress = address;
  }

  #scoped(key) {
    if (!this.contractAddress) {
      throw new Error('setContractAddress must be called before private-state operations');
    }
    return `${this.contractAddress}:${key}`;
  }

  async set(privateStateId, state) {
    this.storage.setItem(STATE_PREFIX + this.#scoped(privateStateId), encodeState(state));
  }

  async get(privateStateId) {
    return decodeState(this.storage.getItem(STATE_PREFIX + this.#scoped(privateStateId)));
  }

  async remove(privateStateId) {
    this.storage.removeItem(STATE_PREFIX + this.#scoped(privateStateId));
  }

  async clear() {
    const doomed = [];
    for (let i = 0; i < this.storage.length; i += 1) {
      const key = this.storage.key(i);
      if (key?.startsWith(STATE_PREFIX)) doomed.push(key);
    }
    doomed.forEach((key) => this.storage.removeItem(key));
  }

  async setSigningKey(address, signingKey) {
    this.storage.setItem(KEY_PREFIX + address, signingKey);
  }

  async getSigningKey(address) {
    return this.storage.getItem(KEY_PREFIX + address);
  }

  async removeSigningKey(address) {
    this.storage.removeItem(KEY_PREFIX + address);
  }

  async clearSigningKeys() {
    const doomed = [];
    for (let i = 0; i < this.storage.length; i += 1) {
      const key = this.storage.key(i);
      if (key?.startsWith(KEY_PREFIX)) doomed.push(key);
    }
    doomed.forEach((key) => this.storage.removeItem(key));
  }
}
