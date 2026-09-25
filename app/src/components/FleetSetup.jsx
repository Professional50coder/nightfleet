import { useCallback, useMemo, useState } from 'react';
import { Board } from './Board.jsx';
import { MagneticButton } from './MagneticButton.jsx';
import { FLEET_CELLS, ORIENTATION } from '../game/protocol.js';
import {
  autoPlace, canPlace, createPlacement, placeShip, removeShip,
  rotateShip, shipAt, shipCells, toBoard, validatePlacement,
} from '../game/placement.js';

/**
 * Fleet placement screen.
 *
 * Click a ship in the tray, then click the board to anchor it. Click a placed
 * ship to pick it up again. R (or the rotate control) turns the selection.
 * Commit stays disabled until `validatePlacement` - which ends in shared's
 * `assertValidFleet` - says the fleet is legal.
 */
export function FleetSetup({ onCommit, busy = false, error = null }) {
  const [placement, setPlacement] = useState(() => createPlacement());
  const [selectedId, setSelectedId] = useState('ship-1');
  const [orientation, setOrientation] = useState(ORIENTATION.HORIZONTAL);
  const [hover, setHover] = useState(null);
  const [settledCells, setSettledCells] = useState([]);
  const [notice, setNotice] = useState(null);

  const validation = useMemo(() => validatePlacement(placement), [placement]);
  const board = useMemo(() => toBoard(placement), [placement]);
  const selected = placement.ships.find((s) => s.id === selectedId) ?? null;
  const unplaced = placement.ships.filter((s) => s.x === null);

  const previewCells = useMemo(() => {
    if (hover === null || !selected || selected.x !== null) return [];
    const check = canPlace(placement, selected.id, { ...hover, orientation });
    return check.cells;
  }, [hover, selected, placement, orientation]);

  const previewInvalid = useMemo(() => {
    if (hover === null || !selected || selected.x !== null) return false;
    return !canPlace(placement, selected.id, { ...hover, orientation }).ok;
  }, [hover, selected, placement, orientation]);

  const onCellActivate = useCallback((index, coord) => {
    setNotice(null);
    const existing = shipAt(placement, index);
    if (existing) {                       // pick a placed ship back up
      setPlacement(removeShip(placement, existing.id));
      setSelectedId(existing.id);
      setOrientation(existing.orientation);
      setSettledCells([]);
      return;
    }
    if (!selected || selected.x !== null) {
      const next = unplaced[0];
      if (!next) { setNotice('Every ship is placed. Click one to move it.'); return; }
      setSelectedId(next.id);
      return;
    }
    const check = canPlace(placement, selected.id, { ...coord, orientation });
    if (!check.ok) { setNotice(check.reason); return; }
    const updated = placeShip(placement, selected.id, { ...coord, orientation });
    setPlacement(updated);
    const placedShip = updated.ships.find((s) => s.id === selected.id);
    setSettledCells(placedShip ? shipCells(placedShip) : []);
    const remaining = updated.ships.find((s) => s.x === null);
    setSelectedId(remaining ? remaining.id : selected.id);
  }, [placement, selected, orientation, unplaced]);

  const rotate = useCallback(() => {
    setNotice(null);
    if (selected && selected.x !== null) {
      try {
        setPlacement(rotateShip(placement, selected.id));
      } catch (err) {
        setNotice(err.message);
      }
      return;
    }
    setOrientation((o) => (o === ORIENTATION.HORIZONTAL ? ORIENTATION.VERTICAL : ORIENTATION.HORIZONTAL));
  }, [placement, selected]);

  const onKeyDown = useCallback((event) => {
    if (event.key === 'r' || event.key === 'R') { event.preventDefault(); rotate(); }
  }, [rotate]);

  const shuffle = useCallback(() => {
    setNotice(null);
    const next = autoPlace();
    setPlacement(next);
    setSettledCells(next.ships.flatMap((ship) => shipCells(ship)));
    setSelectedId('ship-1');
  }, []);

  const clear = useCallback(() => {
    setNotice(null);
    setPlacement(createPlacement());
    setSettledCells([]);
    setSelectedId('ship-1');
  }, []);

  return (
    <section className="panel setup" onKeyDown={onKeyDown}>
      <header className="panel__head">
        <h2>Place your fleet</h2>
        <p className="muted">
          Three ships, {FLEET_CELLS} cells. Pick a ship, click the grid to drop it, press
          <kbd>R</kbd> to rotate. Nothing is sent anywhere &mdash; this layout stays on your device.
        </p>
      </header>

      <div className="setup__body">
        <Board
          mode="editable"
          fleet={board}
          preview={previewCells}
          previewInvalid={previewInvalid}
          settledCells={settledCells}
          caption="Your waters"
          onCellActivate={onCellActivate}
          onCellHover={(_, coord) => setHover(coord)}
        />

        <div className="setup__side">
          <ul className="tray" aria-label="Fleet">
            {placement.ships.map((ship) => (
              <li key={ship.id}>
                <button
                  type="button"
                  className={[
                    'tray__ship',
                    ship.id === selectedId ? 'tray__ship--selected' : '',
                    ship.x !== null ? 'tray__ship--placed' : '',
                  ].filter(Boolean).join(' ')}
                  aria-pressed={ship.id === selectedId}
                  onClick={() => {
                    setSelectedId(ship.id);
                    setOrientation(ship.orientation);
                    setNotice(null);
                  }}
                >
                  <span className="tray__pips" aria-hidden="true">
                    {Array.from({ length: ship.size }, (_, i) => <i key={i} />)}
                  </span>
                  <span className="tray__meta">
                    <strong>{ship.size}-cell</strong>
                    <span className="mono">
                      {ship.x === null ? 'in dock' : `${shipCells(ship).length} placed`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="setup__controls">
            <button type="button" className="btn" onClick={rotate}>Rotate <kbd>R</kbd></button>
            <button type="button" className="btn" onClick={shuffle}>Auto-place</button>
            <button type="button" className="btn btn--ghost" onClick={clear}>Clear</button>
          </div>

          <p className={`setup__status ${validation.ok ? 'ok' : ''}`} role="status">
            {validation.ok
              ? `Fleet ready: ${FLEET_CELLS} cells committed privately.`
              : validation.errors.join(' · ')}
          </p>
          {notice ? <p className="setup__notice" role="alert">{notice}</p> : null}
          {error ? <p className="setup__notice" role="alert">{error}</p> : null}

          <MagneticButton
            className="btn btn--primary btn--wide"
            disabled={!validation.ok || busy}
            onClick={() => validation.board && onCommit(validation.board)}
          >
            {busy ? 'Committing…' : 'Commit fleet'}
          </MagneticButton>
          <p className="muted small">
            Committing publishes a hash of this layout, never the layout itself.
          </p>
        </div>
      </div>
    </section>
  );
}
