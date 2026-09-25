// useGame - the only place the UI touches a driver.
//
// Components receive plain state and callbacks; they never import a driver
// class. That is what makes swapping BrowserLocalDriver for a proof-backed
// driver a one-line change here instead of a rewrite of the battle screen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserLocalDriver } from '../game/local-driver.js';
import { assertDriverShape, DriverError, PHASE } from '../game/driver.js';

/**
 * @param {{ seed?: number, difficulty?: string, createDriver?: () => object }} opts
 */
export function useGame({ seed = 1, difficulty = 'medium', createDriver } = {}) {
  // Seed/difficulty are only the driver's *starting* values; changing them later
  // is a newGame() argument, not a reason to throw away a game in progress.
  const initial = useRef({ seed, difficulty });
  const driver = useMemo(() => {
    const d = createDriver
      ? createDriver()
      : new BrowserLocalDriver({ seed: initial.current.seed, difficulty: initial.current.difficulty });
    return assertDriverShape(d, 'game driver');
  }, [createDriver]);

  const [state, setState] = useState(null);
  const [info, setInfo] = useState(null);
  const [narration, setNarration] = useState([]);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const [nextState, nextNarration, nextLog] = await Promise.all([
      driver.getState(), driver.getNarration(), driver.getShotLog(),
    ]);
    if (!mounted.current) return;
    setState(nextState);
    setNarration(nextNarration);
    setLog(nextLog);
  }, [driver]);

  useEffect(() => {
    let cancelled = false;
    driver.describe().then((d) => { if (!cancelled && mounted.current) setInfo(d); });
    return () => { cancelled = true; };
  }, [driver]);

  // A real driver pushes ledger updates; the local one pushes after each round.
  useEffect(() => driver.subscribe(() => { refresh().catch(() => {}); }), [driver, refresh]);

  /** Wrap a driver call: one busy flag, one error slot, always refreshed after. */
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      await refresh();
      return result;
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof DriverError ? err.message : String(err?.message ?? err));
      }
      return null;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [refresh]);

  const newGame = useCallback((opts) => run(() => driver.newGame(opts)), [driver, run]);
  const commitFleet = useCallback((board) => run(() => driver.commitFleet(board)), [driver, run]);
  const fire = useCallback((coord) => run(() => driver.fire(coord)), [driver, run]);
  const report = useCallback(() => run(() => driver.report()), [driver, run]);
  const revealFleets = useCallback(() => run(() => driver.revealFleets()), [driver, run]);
  const dismissError = useCallback(() => setError(null), []);

  return {
    driver,
    info,
    state,
    narration,
    log,
    error,
    busy,
    phase: state?.phase ?? PHASE.OPEN,
    newGame,
    commitFleet,
    fire,
    report,
    revealFleets,
    refresh,
    dismissError,
  };
}
