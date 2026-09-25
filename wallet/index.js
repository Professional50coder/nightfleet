// @nightfleet/wallet - framework-agnostic Lace / Midnight DApp connector.
//
// Zero runtime dependencies, zero React. The optional React hook lives at
// `@nightfleet/wallet/react` so the core can be used from the CLI, a worker,
// or a test without pulling a renderer in.
//
// Quick start:
//   import { createLaceConnector, WalletStatus } from '@nightfleet/wallet';
//   const wallet = createLaceConnector();      // Preprod-only by default
//   wallet.subscribe(render);
//   wallet.detect();                           // -> 'available' | 'unavailable'
//   await wallet.connect();                    // never rejects; read snapshot.error
//   wallet.getSigner().submitTransaction(tx);  // throws unless connected

export {
  LaceConnector,
  createLaceConnector,
  createWalletStore,
  EMPTY_SNAPSHOT,
} from './src/connector.js';

export {
  WalletStatus,
  WALLET_STATUSES,
  TRANSITIONS,
  canTransition,
  isWalletStatus,
} from './src/state.js';

export {
  WalletError,
  WalletErrorCode,
  WALLET_ERROR_COPY,
} from './src/errors.js';

export {
  NetworkId,
  DEFAULT_EXPECTED_NETWORK_ID,
  ALLOWED_EXPECTED_NETWORK_IDS,
  isMainnetId,
  isPreprodId,
  checkNetwork,
  inferNetworkIdFromUris,
} from './src/networks.js';

export {
  redactAddress,
  redactHash,
  scrubForLog,
  REDACTION,
} from './src/redact.js';

export {
  detectWallets,
  pickWallet,
  parseApiMajor,
  SUPPORTED_API_MAJORS,
} from './src/detect.js';
