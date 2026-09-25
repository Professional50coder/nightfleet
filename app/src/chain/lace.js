// Lace (and any CAIP-372 Midnight wallet) discovery and connection.
//
// Each wallet extension injects its InitialAPI under its own key on
// `window.midnight` (a UUID - never assume a fixed key; Lace's `mnLace`
// alias is a convenience, not the spec). Discovery enumerates the object
// and keeps anything with a `connect` function.

export class WalletError extends Error {}

/**
 * @returns {Array<object>} every injected wallet's InitialAPI
 */
export function findWallets(win = globalThis.window) {
  const bag = win?.midnight ?? {};
  return Object.values(bag).filter((w) => w != null && typeof w.connect === 'function');
}

/**
 * Connect to an injected Midnight wallet.
 *
 * @param {object} opts
 * @param {string} [opts.networkId] Midnight network id ('preprod' for this app)
 * @param {string} [opts.prefer] rdns or display name to prefer when several
 *   wallets are injected; falls back to the first discovered wallet.
 * @param {object} [opts.win] window override (tests)
 * @returns {Promise<{ api: object, wallet: object }>}
 */
export async function connectWallet({ networkId = 'preprod', prefer, win } = {}) {
  const wallets = findWallets(win);
  if (wallets.length === 0) {
    throw new WalletError(
      'no Midnight wallet found in this browser - install the Lace extension, fund it from the preprod faucet, and reload',
    );
  }
  const chosen = (prefer && wallets.find((w) => w.rdns === prefer || w.name === prefer)) || wallets[0];
  const api = await chosen.connect(networkId);
  return { api, wallet: chosen };
}
