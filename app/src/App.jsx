import { useCallback, useMemo, useState } from 'react';
import { Battle } from './components/Battle.jsx';
import { FleetSetup } from './components/FleetSetup.jsx';
import { Home } from './components/Home.jsx';
import { Result } from './components/Result.jsx';
import { useGame } from './hooks/useGame.js';
import { PHASE } from './game/protocol.js';
import { createDriverById, DRIVER_IDS, listDrivers } from './game/drivers.js';
import { parseSquadLink, squadLinkFor } from './chain/squad.js';

/**
 * Screen routing is derived from the driver's phase rather than kept in its own
 * state, so the UI cannot drift out of step with the game:
 *
 *   no game yet -> Home     PLACED_* -> FleetSetup     PLAYING/FINISHED -> Battle
 */
export function App() {
  // A squad link in the URL pre-selects the on-chain engine and the join box.
  const initialSquadLink = globalThis.location?.hash?.includes('#/game/') ? globalThis.location.hash : '';
  const [driverId, setDriverId] = useState(
    initialSquadLink && parseSquadLink(initialSquadLink) ? DRIVER_IDS.MIDNIGHT : DRIVER_IDS.LOCAL,
  );
  const [started, setStarted] = useState(false);
  const [narrationOn, setNarrationOn] = useState(true);
  const drivers = useMemo(() => listDrivers(), []);

  const createDriver = useCallback(() => createDriverById(driverId), [driverId]);
  const game = useGame({ createDriver });

  const start = useCallback(async ({ seed, difficulty }) => {
    const result = await game.newGame({ seed, difficulty });
    if (result) setStarted(true);
  }, [game]);

  const rematch = useCallback(async () => {
    await game.newGame({ seed: (game.state?.seed ?? 1) + 1, difficulty: game.state?.difficulty });
  }, [game]);

  const phase = game.state?.phase ?? PHASE.OPEN;
  const screen = !started ? 'home'
    : phase === PHASE.PLAYING || phase === PHASE.FINISHED ? 'battle'
      : 'setup';

  return (
    <div className="app">
      <div className="app__fog" aria-hidden="true"><i /><i /><i /></div>
      <div className="app__grain" aria-hidden="true" />
      <header className="app__bar">
        <span className="app__mark">NIGHTFLEET</span>
        <span className="muted small">
          {game.info?.provesMoves ? 'proof-backed' : 'local session'} · fog of war, by construction
        </span>
        {started ? (
          <button type="button" className="btn btn--tiny" onClick={() => setStarted(false)}>
            leave game
          </button>
        ) : null}
      </header>

      <main className="app__main">
        {screen === 'home' ? (
          <Home
            drivers={drivers}
            driverId={driverId}
            onDriverChange={setDriverId}
            onStart={start}
            busy={game.busy}
            initialSquadLink={initialSquadLink}
          />
        ) : null}

        {screen === 'setup' ? (
          <FleetSetup
            busy={game.busy}
            error={game.error}
            onCommit={(board) => game.commitFleet(board)}
            squadLink={driverId === DRIVER_IDS.MIDNIGHT && game.state?.contractAddress
              ? squadLinkFor(game.state.contractAddress)
              : null}
          />
        ) : null}

        {screen === 'battle' ? (
          <>
            <Battle
              state={game.state}
              info={game.info}
              log={game.log}
              narration={game.narration}
              busy={game.busy}
              error={game.error}
              narrationOn={narrationOn}
              onToggleNarration={setNarrationOn}
              onFire={(coord) => game.fire(coord)}
              onReport={() => game.report()}
              onDismissError={game.dismissError}
            />
            <Result
              state={game.state}
              busy={game.busy}
              onReveal={() => game.revealFleets()}
              onRematch={rematch}
            />
          </>
        ) : null}
      </main>

      <footer className="app__foot muted small">
        8×8 · fleet [3,2,2] · 7 cells — constants read from <span className="mono">@nightfleet/shared</span>,
        the same module the Compact contract is written against.
      </footer>
    </div>
  );
}

