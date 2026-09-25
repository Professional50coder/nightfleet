// Mock injected DApp connectors.
//
// Shaped from the published type definitions of
// @midnight-ntwrk/dapp-connector-api 4.0.1 (InitialAPI / ConnectedAPI) and
// 3.0.0 (DAppConnectorAPI / DAppConnectorWalletAPI), read from the packages on
// npm. This is a mock of the *spec*, not a recording of a real Lace build -
// see README "Verified vs spec-derived".

/** Realistic-length bech32m values. Fake, but the right shape for redaction. */
export const FAKE_SHIELDED_ADDRESS =
  'mn_shield-addr_test1qqyv8h3t6sxk2u9lr4wzqf7nc5mjda0pe8gxv3r7ykq2w4dt9sh6ve0fs3lz8n';
export const FAKE_UNSHIELDED_ADDRESS =
  'mn_addr_test1asujt0dayj4pelgq97wv75hjhscqv9epmzzpapkf8sy8c87jhh9s6e0fs3';

/** Build the error shape the connector documents (`APIError`). */
export function connectorError(code, reason = 'mock') {
  const e = new Error(`${code}: ${reason}`);
  e.type = 'DAppConnectorAPIError';
  e.code = code;
  e.reason = reason;
  return e;
}

/** A DApp connector API v4 wallet, with knobs for every failure mode. */
export function makeLaceV4(opts = {}) {
  const {
    key = 'mnLace',
    name = 'Lace',
    rdns = 'io.lace',
    icon = 'data:image/png;base64,AAAA',
    apiVersion = '4.0.1',
    networkId = 'preprod',
    shieldedAddress = FAKE_SHIELDED_ADDRESS,
    unshieldedAddress = FAKE_UNSHIELDED_ADDRESS,
    connectError = null,
    connectDelayMs = 0,
    connectResolvesWith = undefined,
    omit = [],
    serviceConfig = {
      indexerUri: 'https://indexer.preprod.midnight.network/api/v4/graphql',
      indexerWsUri: 'wss://indexer.preprod.midnight.network/api/v4/graphql',
      substrateNodeUri: 'wss://rpc.preprod.midnight.network',
    },
    reportNetworkIdInConfig = true,
  } = opts;

  const state = { networkId, connected: true, calls: [] };
  const track = (m) => state.calls.push(m);
  const has = (m) => !omit.includes(m);

  const api = {};
  if (has('getConnectionStatus')) {
    api.getConnectionStatus = async () => {
      track('getConnectionStatus');
      return state.connected
        ? { status: 'connected', networkId: state.networkId }
        : { status: 'disconnected' };
    };
  }
  if (has('getConfiguration')) {
    api.getConfiguration = async () => {
      track('getConfiguration');
      return reportNetworkIdInConfig
        ? { ...serviceConfig, networkId: state.networkId }
        : { ...serviceConfig };
    };
  }
  if (has('getShieldedAddresses')) {
    api.getShieldedAddresses = async () => {
      track('getShieldedAddresses');
      return {
        shieldedAddress,
        shieldedCoinPublicKey: `${shieldedAddress}-cpk`,
        shieldedEncryptionPublicKey: `${shieldedAddress}-epk`,
      };
    };
  }
  if (has('getUnshieldedAddress')) {
    api.getUnshieldedAddress = async () => {
      track('getUnshieldedAddress');
      return { unshieldedAddress };
    };
  }
  if (has('signData')) {
    api.signData = async (data, options) => {
      track('signData');
      return { data, signature: 'sig-mock', verifyingKey: 'vk-mock', options };
    };
  }
  if (has('balanceUnsealedTransaction')) {
    api.balanceUnsealedTransaction = async (tx) => {
      track('balanceUnsealedTransaction');
      return { tx: `balanced-unsealed:${tx}` };
    };
  }
  if (has('balanceSealedTransaction')) {
    api.balanceSealedTransaction = async (tx) => {
      track('balanceSealedTransaction');
      return { tx: `balanced-sealed:${tx}` };
    };
  }
  if (has('submitTransaction')) {
    api.submitTransaction = async (tx) => {
      track('submitTransaction');
      if (!state.connected) throw connectorError('Disconnected', 'connection lost');
      return `txid:${tx}`;
    };
  }
  if (has('getProvingProvider')) {
    api.getProvingProvider = async (kmp) => {
      track('getProvingProvider');
      return { check: async () => [], prove: async () => new Uint8Array([1]), kmp };
    };
  }
  if (has('hintUsage')) {
    api.hintUsage = async (methods) => { track(`hintUsage:${methods.join(',')}`); };
  }
  // Methods we must NOT forward to the game layer; present so tests can prove
  // the connector does not expose them.
  api.getShieldedBalances = async () => { track('getShieldedBalances'); return {}; };
  api.getUnshieldedBalances = async () => { track('getUnshieldedBalances'); return {}; };
  api.getDustBalance = async () => { track('getDustBalance'); return { cap: 0n, balance: 0n }; };
  api.getTxHistory = async () => { track('getTxHistory'); return []; };

  const provider = {
    rdns,
    name,
    icon,
    apiVersion,
    connect: async (hint) => {
      track(`connect:${hint}`);
      if (connectDelayMs > 0) await new Promise((r) => { setTimeout(r, connectDelayMs); });
      if (connectError) throw connectError;
      if (connectResolvesWith !== undefined) return connectResolvesWith;
      return api;
    },
  };

  return {
    key,
    provider,
    api,
    state,
    setNetworkId(id) { state.networkId = id; },
    dropConnection() { state.connected = false; },
  };
}

/** A legacy DApp connector API v3 wallet. */
export function makeLaceV3(opts = {}) {
  const {
    key = 'mnLace',
    name = 'Lace',
    apiVersion = '3.0.0',
    address = FAKE_SHIELDED_ADDRESS,
    enableError = null,
    serviceConfig = {
      indexerUri: 'https://indexer.preprod.midnight.network/api/v4/graphql',
      indexerWsUri: 'wss://indexer.preprod.midnight.network/api/v4/graphql',
      proverServerUri: 'http://localhost:6300',
      substrateNodeUri: 'wss://rpc.preprod.midnight.network',
    },
  } = opts;

  const state = { enabled: true, calls: [] };
  const track = (m) => state.calls.push(m);

  const walletApi = {
    state: async () => {
      track('state');
      return {
        address,
        addressLegacy: `${address}-legacy`,
        coinPublicKey: `${address}-cpk`,
        coinPublicKeyLegacy: `${address}-cpk-legacy`,
        encryptionPublicKey: `${address}-epk`,
        encryptionPublicKeyLegacy: `${address}-epk-legacy`,
      };
    },
    balanceAndProveTransaction: async (tx, newCoins) => {
      track('balanceAndProveTransaction');
      return { tx: `balanced-proven:${tx}`, newCoins };
    },
    submitTransaction: async (tx) => { track('submitTransaction'); return `txid:${tx}`; },
  };

  const provider = {
    name,
    apiVersion,
    isEnabled: async () => { track('isEnabled'); return state.enabled; },
    serviceUriConfig: async () => { track('serviceUriConfig'); return { ...serviceConfig }; },
    enable: async () => {
      track('enable');
      if (enableError) throw enableError;
      return walletApi;
    },
  };

  return { key, provider, api: walletApi, state, disable() { state.enabled = false; } };
}

/** Assemble a fake `window` carrying zero or more injected wallets. */
export function makeWindow(...wallets) {
  const midnight = {};
  for (const w of wallets) midnight[w.key] = w.provider;
  return { midnight };
}

/** A `window` with nothing installed. */
export function emptyWindow() {
  return {};
}
