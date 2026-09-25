import { useEffect, useState } from 'react';
import { Board } from './Board.jsx';
import { Hud } from './Hud.jsx';
import { Inspector } from './Inspector.jsx';
import { Narrator } from './Narrator.jsx';
import { ShotLog } from './ShotLog.jsx';
import { MARK, PHASE, SEAT, coordinateToIndex, formatCoordinate } from '../game/protocol.js';

/**
 * The battle screen: your waters (fleet visible, incoming shots marked) beside
 * enemy waters (fog; only cells you have fired at say anything).
 *
 * Note what is passed to each <Board>: the enemy board gets
 * `fleet={state.opponent.fleet}`, which the driver holds at null for the whole
 * game and only fills after revealFleets(). There is no code path in this
 * component that could draw an enemy ship early, because the data never arrives.
 */
export function Battle({
  state, info, log, narration, busy, error,
  narrationOn, onToggleNarration, onFire, onDismissError,
}) {
  const [ripple, setRipple] = useState(null); // enemy cell the player just fired at

  // The ripple lives only while the answer is in flight: it clears the moment
  // your shot is answered, and it must never linger over a driver refusal.
  useEffect(() => {
    if (state?.lastShot?.seat === SEAT.YOU) setRipple(null);
  }, [state?.lastShot]);
  useEffect(() => {
    if (error) setRipple(null);
  }, [error]);

  if (!state) return null;
  const yourTurn = state.phase === PHASE.PLAYING && state.turn === SEAT.YOU && !busy;
  const last = state.lastShot;
  // The cell the latest shot landed on, per side, so that board can pulse it
  // once. Micro-feedback on every answer is core feedback, not decoration.
  const freshEnemy = last && last.seat === SEAT.YOU ? coordinateToIndex(last.coord) : null;
  const freshMine = last && last.seat === SEAT.OPPONENT ? coordinateToIndex(last.coord) : null;
  const playing = state.phase === PHASE.PLAYING && !state.winner;

  return (
    <section className="battle">
      <Hud state={state} info={info} busy={busy} />

      {error ? (
        <p className="alert" role="alert">
          {error}
          <button type="button" className="btn btn--tiny" onClick={onDismissError}>dismiss</button>
        </p>
      ) : null}

      <div className="battle__boards">
        <Board
          mode="mine"
          fleet={state.you.fleet}
          marks={state.you.marks}
          caption="Your waters"
          freshIndex={freshMine}
          active={playing && !yourTurn}
        />
        <Board
          mode="enemy"
          fleet={state.opponent.fleet}
          marks={state.opponent.marks}
          disabled={!yourTurn}
          freshIndex={freshEnemy}
          active={playing && yourTurn}
          caption={state.revealed ? 'Enemy waters — revealed' : 'Enemy waters — fog'}
          rippleIndex={ripple}
          onCellActivate={(index, coord) => {
            if (state.opponent.marks[index] !== MARK.UNKNOWN) return;
            setRipple(index); // fire ripples from the clicked cell
            onFire(coord);
          }}
        />
      </div>

      {last ? (
        <p className={`battle__last battle__last--${last.result}`} aria-live="polite">
          <span className="mono">{formatCoordinate(last.coord)}</span>
          {' '}
          {last.seat === SEAT.YOU ? 'you fired' : 'they fired'} → <strong>{last.result.toUpperCase()}</strong>
        </p>
      ) : (
        <p className="battle__last muted">Pick a cell on the enemy grid to fire.</p>
      )}

      <div className="battle__aside">
        <Narrator lines={narration} enabled={narrationOn} onToggle={onToggleNarration} />
        <ShotLog entries={log} />
        <Inspector state={state} log={log} provesMoves={!!info?.provesMoves} />
      </div>

      {last && last.result === 'hit' ? (
        // A hit flashes the screen edge. Pointer-inert,
        // opacity-only, keyed per shot so each fresh hit replays it.
        <div
          key={`${last.seat}-${last.coord.x}-${last.coord.y}`}
          className="battle__flash"
          data-testid="hit-flash"
          aria-hidden="true"
        />
      ) : null}
    </section>
  );
}
