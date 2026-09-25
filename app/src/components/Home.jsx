import { useState } from 'react';
import { DIFFICULTIES, DRIVER_IDS } from '../game/drivers.js';
import { parseSquadLink } from '../chain/squad.js';
import { MagneticButton } from './MagneticButton.jsx';
import { useReveal } from '../hooks/useReveal.js';
import { WobbleCard } from './WobbleCard.jsx';

/**
 * Landing screen. The driver picker is deliberately visible: it is the honest
 * version of "what is backing this game right now", and the unavailable
 * proof-backed option states why it is not live instead of hiding.
 */
export function Home({ drivers, driverId, onDriverChange, onStart, busy, initialSquadLink = '' }) {
  const heroRef = useReveal();
  const setupRef = useReveal();
  const [difficulty, setDifficulty] = useState('medium');
  const [seed, setSeed] = useState(1);
  const [squadLink, setSquadLink] = useState(initialSquadLink);

  const onChain = driverId === DRIVER_IDS.MIDNIGHT;
  const joinAddress = parseSquadLink(squadLink);
  const start = () => (onChain
    ? onStart({ contractAddress: joinAddress || undefined })
    : onStart({ seed, difficulty }));

  return (
    <section className="home">
      <WobbleCard>
        <div className="home__hero reveal" ref={heroRef}>
        <h1>Night<em>Fleet</em></h1>
        <p className="home__tagline">
          Battleship where your fleet is never revealed. You commit to a layout before the first
          shot, and every answer after that has to match it.
        </p>
        </div>
      </WobbleCard>

      <WobbleCard>
        <div className="panel home__setup reveal" ref={setupRef}>
        {onChain ? (
          <fieldset className="field">
            <legend>Squad link</legend>
            <input
              className="input mono"
              type="text"
              value={squadLink}
              onChange={(e) => setSquadLink(e.target.value)}
              placeholder="paste a squad link to join - or leave empty to host"
              aria-label="Squad link"
            />
            <p className="muted small">
              {squadLink && !joinAddress
                ? 'That does not look like a squad link - it should end in #/game/<64 hex characters>.'
                : 'Empty hosts a fresh game and gives you a link to share. A pasted link joins that game on Preprod. Lace will ask to connect.'}
            </p>
          </fieldset>
        ) : null}

        {onChain ? null : (
        <fieldset className="field">
          <legend>Opponent</legend>
          <div className="segmented">
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                type="button"
                className={`segmented__item ${d === difficulty ? 'is-on' : ''}`}
                aria-pressed={d === difficulty}
                onClick={() => setDifficulty(d)}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="muted small">
            The AI is deterministic and seeded — the same seed replays the same game.
          </p>
        </fieldset>
        )}

        {onChain ? null : (
        <fieldset className="field">
          <legend>Seed</legend>
          <input
            className="input mono"
            type="number"
            value={seed}
            min={0}
            onChange={(e) => setSeed(Number(e.target.value) || 0)}
            aria-label="Game seed"
          />
        </fieldset>
        )}

        <fieldset className="field">
          <legend>Engine</legend>
          <div className="drivers">
            {drivers.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`drivers__item ${d.id === driverId ? 'is-on' : ''} ${d.available ? '' : 'is-off'}`}
                aria-pressed={d.id === driverId}
                disabled={!d.available}
                onClick={() => onDriverChange(d.id)}
              >
                <strong>{d.name}</strong>
                <span className="muted small">{d.available ? d.summary : d.reason}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <MagneticButton
          className="btn btn--primary btn--wide"
          onClick={start}
          disabled={busy || (onChain && squadLink.trim() !== '' && !joinAddress)}
        >
          {busy ? (
            <span className="btn__busy">
              <i className="dot dot--live" aria-hidden="true" /> Setting up…
            </span>
          ) : onChain ? (
            joinAddress ? 'Join squad' : 'Create squad'
          ) : (
            'Play vs AI'
          )}
        </MagneticButton>
        </div>
      </WobbleCard>
    </section>
  );
}
