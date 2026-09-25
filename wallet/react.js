// @nightfleet/wallet/react - OPTIONAL React binding.
//
// Separate entry point on purpose: importing '@nightfleet/wallet' must never
// pull React in. This file is glue only - all behaviour lives in the core and
// is tested there (see test/store.test.js, which exercises the exact
// subscribe/getSnapshot pair this hook hands to useSyncExternalStore).
//
// `react` is an optional peer dependency; this module is not imported by the
// core and is not covered by the package's own unit tests.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createLaceConnector, createWalletStore } from './src/connector.js';

/**
 * Subscribe a component to a connector.
 *
 * Pass a connector you own (recommended - one per app, created outside React
 * so it survives Strict Mode double-mounting), or options to have the hook
 * create one for you.
 *
 * @param {import('./src/connector.js').LaceConnector|object} [connectorOrOptions]
 * @returns {{
 *   status: string,
 *   snapshot: import('./src/connector.js').WalletSnapshot,
 *   connector: import('./src/connector.js').LaceConnector,
 *   connect: () => Promise<object>,
 *   disconnect: () => object,
 *   clearError: () => object,
 * }}
 */
export function useLaceWallet(connectorOrOptions) {
  const connector = useMemo(() => {
    if (connectorOrOptions && typeof connectorOrOptions.subscribe === 'function') {
      return connectorOrOptions;
    }
    return createLaceConnector(connectorOrOptions ?? {});
  }, [connectorOrOptions]);

  const store = useMemo(() => createWalletStore(connector), [connector]);

  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  useEffect(() => {
    connector.detect();
    // A wallet installed or unlocked in another tab only shows up on focus.
    const onFocus = () => {
      connector.detect();
      void connector.checkConnection();
    };
    const target = typeof window !== 'undefined' ? window : null;
    target?.addEventListener('focus', onFocus);
    return () => target?.removeEventListener('focus', onFocus);
  }, [connector]);

  const connect = useCallback(() => connector.connect(), [connector]);
  const disconnect = useCallback(() => connector.disconnect(), [connector]);
  const clearError = useCallback(() => connector.clearError(), [connector]);

  return { status: snapshot.status, snapshot, connector, connect, disconnect, clearError };
}
