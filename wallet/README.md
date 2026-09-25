# nightfleet/wallet

`@nightfleet/wallet` — a framework-agnostic Lace / Midnight DApp-connector for
NightFleet. Detects the injected wallet, requests authorization, **verifies the
wallet is on Preprod**, and exposes a deliberately narrow signing surface plus a
redacted address for display.

Zero runtime dependencies. Zero React in the core; the optional React hook is a
separate entry point.

> **Not yet tested against a real Lace extension.** Everything here is exercised
> against a mock injected provider built from the published
> `@midnight-ntwrk/dapp-connector-api` type definitions. Until Lace is installed
> and pointed at Preprod, treat the live behaviour as unverified — see
> [Verified vs spec-derived](#verified-vs-spec-derived).

## Install

```sh
cd nightfleet/wallet
npm install
npx vitest run
```

The frontend consumes it as a local package (it is `private`, never published):

```jsonc
// nightfleet/app/package.json
{ "dependencies": { "@nightfleet/wallet": "file:../wallet" } }
```

## The state machine

Five states, one legal-transition table (`src/state.js`). The UI renders
`snapshot.status` directly and never has to reconcile a bag of booleans.

```
                     detect()                connect()
   unavailable ─────────────────▶ available ───────────▶ connecting
        ▲                           ▲    ▲                 │     │
        │  provider removed         │    │ disconnect()    │     │ any failure
        └───────────────────────────┘    └─────────────────┤     ▼
                                                           │   error
                                     connected ◀───────────┘     │
                                          │   (network verified) │
                                          └──────────────────────┘
                                             retry / clearError()
```

| From | To | Cause |
|---|---|---|
| `unavailable` | `available` | a supported connector appeared on `window.midnight` |
| `unavailable` | `error` | `connect()` called with nothing installed |
| `available` | `connecting` | `connect()` |
| `available` | `unavailable` | extension disabled or removed |
| `connecting` | `connected` | authorized **and** network verified |
| `connecting` | `error` | rejection, lock, wrong network, timeout, version mismatch |
| `connected` | `available` | `disconnect()` |
| `connected` | `error` | wallet dropped the session |
| `connected` | `unavailable` | extension removed mid-session |
| `error` | `connecting` | retry via `connect()` |
| `error` | `available` | `clearError()` |

`connected` is the **only** state in which `getSigner()` works, and reaching it
requires a verified network. There is no path from `available` straight to
`connected`; the transition table enforces it and `test/state.test.js` pins it.

## Public API

```js
import { createLaceConnector, WalletStatus, WalletErrorCode } from '@nightfleet/wallet';

const wallet = createLaceConnector({
  expectedNetworkId: 'preprod',   // default; 'mainnet' throws at construction
  timeoutMs: 60_000,              // per wallet call
  watchIntervalMs: 10_000,        // mid-session liveness poll; 0 disables
  addressKind: 'shielded',        // or 'unshielded'
  allowInferredNetwork: false,    // accept a heuristic network id (see below)
  redaction: { lead: 10, tail: 6 },
  walletKey: undefined,           // pin an exact window.midnight key
  logger: undefined,              // (event, scrubbedData) => void
});
```

### Reading state

| Member | Returns | Notes |
|---|---|---|
| `getSnapshot()` | `WalletSnapshot` | frozen; **referentially stable** until something really changes |
| `subscribe(fn)` | `() => void` | unsubscribe; a throwing listener cannot break the machine |
| `listWallets()` | `DetectedWallet[]` | for a wallet-picker; raw provider objects are stripped |

### Acting

| Member | Returns | Notes |
|---|---|---|
| `detect()` | `WalletSnapshot` | sync, never throws. Call on mount and on window focus |
| `connect()` | `Promise<WalletSnapshot>` | **never rejects.** Failures land in `snapshot.error`. Concurrent calls share one attempt |
| `disconnect()` | `WalletSnapshot` | local only — see the caveat below |
| `clearError()` | `WalletSnapshot` | dismiss without reconnecting |
| `checkConnection()` | `Promise<WalletSnapshot>` | one liveness poll; wire to window focus as well as the timer |
| `destroy()` | `void` | stops the poll, drops listeners |

### Using the wallet

| Member | Notes |
|---|---|
| `getSigner()` | throws `WalletError(NOT_CONNECTED)` unless connected **and** network-verified |
| `revealAddress()` | `Promise<string>` — the raw address. Explorer links and clipboard only. Never log it |

`getSigner()` returns a frozen object with exactly:

```js
{
  networkId,                              // verified, e.g. 'preprod'
  capabilities,                           // { signData, balanceTransaction, ... }
  getServiceConfig(),                     // indexer / node URIs the user configured
  signData(data, { encoding, keyType }),
  balanceTransaction(tx, { sealed?, payFees? }),   // unsealed by default
  submitTransaction(tx),
  getProvingProvider(keyMaterialProvider), // the HTTP-proof fallback
}
```

Balances, dust, transfers and transaction history are reachable on the raw
connector and are **deliberately not forwarded** — NightFleet has no business
reading them (`test/signer.test.js` asserts their absence).

### Snapshot shape

```js
{
  status,            // 'unavailable' | 'available' | 'connecting' | 'connected' | 'error'
  wallet,            // { key, name, icon, rdns, apiVersion, flavor, isLace } | null
  address,           // REDACTED for display, e.g. 'mn_shield-…fs3lz8n' | null
  networkId,         // 'preprod' | null
  networkVerified,   // true only when we proved it
  networkInferred,   // true when the id came from a URI heuristic
  capabilities,      // what the connected wallet can actually do | null
  error,             // { code, userMessage, action, retryable } | null
  connectedAt,       // epoch ms | null
}
```

`wallet.name` and `wallet.icon` come straight from the extension. The connector
spec says to treat them as untrusted: render `name` as a **text node** and
`icon` only as an `<img src>`. This package passes them through unchanged
rather than pretending they are safe.

## Failure modes

Every one is a distinct `error.code`, with fixed UI copy in `src/errors.js`.
`userMessage` and `action` are derived **only** from the code — wallet-supplied
text never reaches the UI, so it cannot carry an address or an injection.

| Code | Trigger | `retryable` |
|---|---|---|
| `NO_PROVIDER` | extension not installed, or removed mid-session | yes |
| `UNSUPPORTED_API_VERSION` | connector major outside `[4, 3]`, or a non-semver `apiVersion` | no |
| `USER_REJECTED` | user dismissed the authorization prompt (`Rejected`) | yes |
| `PERMISSION_DENIED` | wallet refused a permission (`PermissionRejected`) | yes |
| `WALLET_LOCKED` | rejection whose reason mentions a lock (**heuristic**) | yes |
| `WRONG_NETWORK` | connected, but not to the expected network | yes |
| `MAINNET_REFUSED` | wallet is on mainnet — NightFleet never runs there | yes |
| `NETWORK_UNVERIFIED` | the network could not be proven → we refuse to connect | yes |
| `DISCONNECTED` | wallet dropped the session | yes |
| `TIMEOUT` | no answer within `timeoutMs` (Preprod sync is known to hang) | yes |
| `NOT_CONNECTED` | `getSigner()` / `revealAddress()` used too early | yes |
| `UNSUPPORTED_OPERATION` | the connected wallet lacks that method | no |
| `INVALID_REQUEST` | wallet rejected the request as malformed | no |
| `INTERNAL_ERROR` | anything else | yes |

Three things worth calling out:

- **Wrong network fails closed.** If the wallet will not tell us its network we
  emit `NETWORK_UNVERIFIED` and stay out of `connected`. A silent wrong-network
  connection is the classic demo-killer; guessing is worse than refusing.
- **Mainnet has its own code and its own copy.** Project policy is
  Preprod-only, and `expectedNetworkId: 'mainnet'` throws at construction.
- **`WALLET_LOCKED` is a heuristic.** The connector API has no "locked" code; we
  match `/lock|unlock/i` in the rejection reason and otherwise report
  `USER_REJECTED`. Both are retryable, so a mis-classification costs a wrong
  sentence of copy, not a broken flow.

### Caveat: `disconnect()` is local

The DApp connector API has no revoke. `disconnect()` drops our session and
returns to `available`; the wallet keeps its own permission record, so a later
`connect()` may not re-prompt. The UI should say "Disconnect" and not promise
that access was revoked.

## Privacy rules

1. Raw addresses **never** enter a snapshot, an event, or an error. Only
   `revealAddress()` returns one, and only while connected.
2. Everything passed to `logger` goes through `scrubForLog()`: secret-shaped
   keys (`seed`, `mnemonic`, `privateKey`, `secretKey`, `passphrase`, `token`,
   `password`, …) become `[redacted]`, and address-shaped strings are redacted
   in place — including inside nested objects.
3. This package never calls `console.*`. Nothing is persisted. Nothing is sent
   anywhere. The wallet's own service URIs are only read, never stored.
4. No seed, mnemonic, or private key is ever requested, and the connector API
   provides no way to obtain one.

`test/signer.test.js` asserts (2) end-to-end across a successful connect, a
disconnect, and a mainnet refusal.

## How the app consumes it

**Core (any framework):**

```js
import { createLaceConnector, WalletStatus } from '@nightfleet/wallet';

const wallet = createLaceConnector();          // module scope: one per app
wallet.subscribe(render);
wallet.detect();

async function onConnectClick() {
  const s = await wallet.connect();            // never throws
  if (s.status === WalletStatus.ERROR) toast(s.error.userMessage, s.error.action);
}
```

**React (optional entry point):**

```jsx
import { useLaceWallet } from '@nightfleet/wallet/react';

export function WalletButton({ connector }) {   // create it outside React
  const { snapshot, connect, disconnect } = useLaceWallet(connector);
  switch (snapshot.status) {
    case 'unavailable': return <Button onClick={connect}>Install Lace</Button>;
    case 'available':   return <Button onClick={connect}>Connect wallet</Button>;
    case 'connecting':  return <Button disabled>Check Lace…</Button>;
    case 'connected':   return <Pill mono onClick={disconnect}>{snapshot.address}</Pill>;
    case 'error':       return <Button danger onClick={connect} title={snapshot.error.action}>
                                 {snapshot.error.userMessage}
                               </Button>;
  }
}
```

The hook already calls `detect()` on mount and re-detects plus polls on window
focus — a wallet installed or unlocked in another tab only shows up then.

**Wallet-optional reads.** Spectate, replay and vs-AI must work with
no wallet at all. Nothing in this package runs on import: construct the
connector, render `unavailable`, and let the rest of the app proceed.

**Deploy / game layer:**

```js
const signer = wallet.getSigner();              // throws if not connected
const { indexerUri, indexerWsUri, substrateNodeUri } = await signer.getServiceConfig();
const balanced = await signer.balanceTransaction(unprovenTx);
await signer.submitTransaction(balanced.tx);
// and, when the local HTTP proof server errors:
const provingProvider = await signer.getProvingProvider(zkConfigProvider);
```

Mono font for the address pill and every hash.

## Verified vs spec-derived

Being precise about this, because a confident guess here costs a demo.

**Runtime-verified** — read from the actual packages installed from npm:

- `@midnight-ntwrk/dapp-connector-api@4.0.1` `dist/api.d.ts`, `dist/errors.d.ts`,
  `dist/globals.d.ts`: `window.midnight` is a record of wallet-id → `InitialAPI`
  (`rdns`, `name`, `icon`, `apiVersion`, `connect(networkId)`), `ConnectedAPI`
  (`getShieldedAddresses`, `getUnshieldedAddress`, `getConfiguration`,
  `getConnectionStatus`, `signData`, `balanceUnsealedTransaction`,
  `balanceSealedTransaction`, `submitTransaction`, `getProvingProvider`,
  `hintUsage`, …), and the `ErrorCodes` set
  (`InternalError`, `Rejected`, `InvalidRequest`, `PermissionRejected`,
  `Disconnected`) with the `{ type: 'DAppConnectorAPIError', code, reason }`
  error shape.
- `@midnight-ntwrk/dapp-connector-api@3.0.0`: the legacy `DAppConnectorAPI`
  (`isEnabled`, `serviceUriConfig`, `enable`) and `DAppConnectorWalletAPI`
  (`state`, `balanceAndProveTransaction`, `submitTransaction`). That major has
  **no** `signData`, **no** `getProvingProvider`, and **no** network id.
- `@midnight-ntwrk/midnight-js-network-id@4.1.1`: `NetworkId` is a bare
  `string`. There is no enum of network names to validate against.

**Spec-derived / unverified** — coded to the documented surface and isolated so
each is a one-line change:

1. **The literal string Lace reports for Preprod.** `'preprod'` comes from
   The connector README only names `'mainnet'`. If Lace reports
   something else, pass `expectedNetworkId`; only `src/networks.js` cares.
2. **Which connector major a shipping Lace injects.** The docs say
   `window.midnight.mnLace`. We accept *any* key, rank Lace-looking ones first,
   and drive both majors — but which one a real build exposes is unconfirmed.
3. **That the 4.x `connect(networkId)` hint changes wallet behaviour.** We pass
   it and then verify independently, so it does not matter if it is ignored.
4. **The `WALLET_LOCKED` heuristic** (no dedicated code exists).
5. **`inferNetworkIdFromUris`** — reading preprod/mainnet out of the configured
   host names. A heuristic by construction, which is why it is refused unless
   `allowInferredNetwork: true`.
6. **Whether Lace honours `hintUsage`.** We call it; a failure is swallowed.
7. **Real proving-provider and balancing behaviour.** The shapes are typed, but
   nothing here has round-tripped a real transaction.

**Not depended on at runtime.** `@midnight-ntwrk/dapp-connector-api` is
types-only plus a five-string constant; this package inlines the error codes and
takes no `@midnight-ntwrk` dependency, which also keeps it clear of the shared
`compact-runtime` type-identity hoisting the CI does for the other packages.

### First real-extension checklist

Once Lace is installed on Preprod, in order:

1. `console.log(Object.keys(window.midnight))` — confirm the key and that
   `detect()` reports `available`.
2. Check `wallet.apiVersion` against `SUPPORTED_API_MAJORS` (`[4, 3]`).
3. `connect()` and read `snapshot.networkId` — **this is the string that settles
   item 1 above.** If it is not `preprod`, set `expectedNetworkId` and note it in the
   project notes.
4. Reject the prompt on purpose → expect `USER_REJECTED`.
5. Lock Lace, retry → check whether `WALLET_LOCKED` or `USER_REJECTED` comes back
   and tighten the heuristic if needed.
6. Switch Lace to another network, reconnect → expect `WRONG_NETWORK`, and the
   button must **not** go green.

## Tests

```sh
npx vitest run     # 132 tests, 8 files
```

All against a mock injected provider (`test/mock-provider.js`) — no extension
required, so this runs in CI.

| File | Covers |
|---|---|
| `state.test.js` | every legal edge, and that no illegal one is reachable |
| `detect.test.js` | injection, version gate, multi-wallet ranking, hostile getters |
| `networks.test.js` | the Preprod guard, mainnet refusal, fail-closed inference |
| `redact.test.js` | address redaction, log scrubbing, secret-key dropping |
| `connect.test.js` | the full lifecycle and every failure mode above |
| `signer.test.js` | the signing surface, what it refuses to expose, privacy |
| `legacy-v3.test.js` | the 3.x path and its reduced capabilities |
| `store.test.js` | snapshot stability for `useSyncExternalStore` |

`react.js` is glue over `createWalletStore`, which `store.test.js` exercises
directly; the hook itself is not unit-tested (that would mean pulling a renderer
into a package whose point is having no React dependency).

**Not covered by CI yet:** `.github/workflows/ci.yml` iterates
`shared contract api ai cli`. Add `wallet` to that list — it needs no Compact
toolchain and no `@midnight-ntwrk` hoisting.
