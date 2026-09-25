import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// local-game.js (api) and the compiled contract (contract/managed) each resolve
// their own copy of @midnight-ntwrk/compact-runtime; two live copies break the
// runtime's instanceof checks (ContractState "unexpected type"). Alias both to
// the contract package's copy so tests run against a single runtime instance.
const contractRuntime = (pkg) => path.resolve(here, '../contract/node_modules', pkg);

export default {
  resolve: {
    alias: {
      '@midnight-ntwrk/compact-runtime': contractRuntime('@midnight-ntwrk/compact-runtime'),
      '@midnight-ntwrk/onchain-runtime-v3': contractRuntime('@midnight-ntwrk/onchain-runtime-v3'),
    },
  },
};
