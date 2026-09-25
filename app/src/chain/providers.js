// Assemble the six midnight-js providers from a connected wallet's
// DApp Connector API. The wallet supplies the endpoints (getConfiguration),
// signs and balances transactions (balanceUnsealedTransaction), submits them
// (submitTransaction), and proves them (dappConnectorProvingProvider), so no
// key material or proof server is ever hosted by this app.

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { dappConnectorProvingProvider } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { toHex, fromHex } from '@midnight-ntwrk/midnight-js-utils';
import { Transaction } from '@midnight-ntwrk/ledger-v8';

/**
 * @param {object} api ConnectedAPI from connectWallet()
 * @param {object} privateStateProvider BrowserPrivateStateProvider
 * @param {string} zkBaseUrl base URL serving /keys and /zkir (this app's origin)
 * @returns {Promise<object>} MidnightProviders for the NightFleet contract
 */
export async function createBrowserProviders(api, privateStateProvider, zkBaseUrl) {
  const config = await api.getConfiguration();
  setNetworkId(config.networkId);

  const publicDataProvider = indexerPublicDataProvider(config.indexerUri, config.indexerWsUri);
  const zkConfigProvider = new FetchZkConfigProvider(zkBaseUrl, fetch.bind(globalThis));
  const proofProvider = await dappConnectorProvingProvider(api, zkConfigProvider);

  const { shieldedCoinPublicKey, shieldedEncryptionPublicKey } = await api.getShieldedAddresses();

  const walletProvider = {
    getCoinPublicKey: () => shieldedCoinPublicKey,
    getEncryptionPublicKey: () => shieldedEncryptionPublicKey,
    // The connector speaks serialized hex: serialize the unbound tx, let the
    // wallet select fee inputs and bind it, deserialize the result.
    balanceTx: async (tx) => {
      const { tx: balancedHex } = await api.balanceUnsealedTransaction(toHex(tx.serialize()), {});
      return Transaction.deserialize('signature', 'proof', 'binding', fromHex(balancedHex));
    },
  };

  const midnightProvider = {
    submitTx: async (tx) => {
      await api.submitTransaction(toHex(tx.serialize()));
      return tx.identifiers()[0];
    },
  };

  return {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  };
}
