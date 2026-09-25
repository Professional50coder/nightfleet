import { useEffect, useState } from 'react';
import { formatCoordinate, SEAT } from '../game/protocol.js';
import { EmptyState } from './EmptyState.jsx';
import { useGlow } from './Glow.jsx';

const CIRCUIT_LABEL = {
  commitBoard: 'commit',
  fire: 'fire',
  report: 'report',
  claimWin: 'claim win',
  revealBoard: 'reveal',
};

/**
 * The public transcript. Every line here is something the ledger would also
 * know - a commitment, a coordinate, a single cell's hit/miss. Nothing in this
 * list could be used to reconstruct a board that was not fired at, which is the
 * point: this is exactly the audit trail a spectator gets.
 *
 * docs/18 section 3: the timeline under the list replays the match. Scrubbing
 * left rewinds the public record to that moment; the row that just became the
 * latest one pulses once so the "playhead" is visible.
 */
export function ShotLog({ entries = [] }) {
  const [cursor, setCursor] = useState(entries.length);
  const glow = useGlow();
  const [scrubbed, setScrubbed] = useState(false);

  // New entries land on the end of the record; unless the user is actively
  // rewinding, the playhead follows the live edge.
  useEffect(() => {
    if (!scrubbed) setCursor(entries.length);
  }, [entries.length, scrubbed]);

  const replayed = entries.slice(0, cursor);
  const shown = [...replayed].reverse();
  const playheadSeq = replayed.length ? replayed[replayed.length - 1].seq : null;

  return (
    <section
      ref={glow.ref}
      onPointerMove={glow.onPointerMove}
      onPointerLeave={glow.onPointerLeave}
      className="panel log glow"
      aria-label="Shot log"
    >
      <header className="panel__head panel__head--tight">
        <h3>Public log</h3>
        <span className="muted small">{entries.length} entries</span>
      </header>
      {entries.length > 0 ? (
        <div className="log__timeline">
          <span className="log__ticks" aria-hidden="true">
            {entries.map((e) => (
              <i
                key={e.seq}
                className={`log__tick log__tick--${e.result ?? e.circuit}${e.seq < cursor ? ' on' : ''}`}
              />
            ))}
          </span>
          <input
            type="range"
            className="log__scrub"
            min={0}
            max={entries.length}
            value={cursor}
            aria-label="Scrub the public log"
            onChange={(ev) => {
              setCursor(Number(ev.target.value));
              setScrubbed(true);
            }}
          />
        </div>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState
          title="Nothing has happened on the public record yet."
          hint="Commitments and shots will appear here as they happen."
        />
      ) : (
        <ol className="log__list">
          {shown.map((e) => (
            <li
              key={e.seq}
              className={`log__row log__row--${e.result ?? e.circuit}${e.seq === playheadSeq && scrubbed ? ' log__row--fresh' : ''}`}
            >
              <span className="mono log__seq">{String(e.seq).padStart(2, '0')}</span>
              <span className="log__who">{e.seat === SEAT.YOU ? 'you' : 'ai'}</span>
              <span className="log__what">{CIRCUIT_LABEL[e.circuit] ?? e.circuit}</span>
              <span className="mono log__coord">{e.coord ? formatCoordinate(e.coord) : '—'}</span>
              <span className={`log__result log__result--${e.result ?? 'none'}`}>
                {e.result ? e.result.toUpperCase() : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
