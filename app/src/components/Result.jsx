import { SEAT } from '../game/protocol.js';
import { MagneticButton } from './MagneticButton.jsx';

/**
 * End-of-game card.
 *
 * "Reveal & audit" is the only control in the whole UI that asks for a hidden
 * board, and the driver refuses it unless the game is FINISHED. That refusal is
 * the product feature, not a limitation: the layout stayed hidden for the whole
 * match and is opened afterwards only so the loser's honesty can be checked.
 *
 * docs/18 §2 win moment: on a win the card plays a pure-CSS confetti burst and
 * the headline springs in. The pieces are deterministic (positions derive from
 * the index) so the render is stable in tests, aria-hidden so the role="status"
 * announcement stays the plain result text, and the whole layer is removed
 * under prefers-reduced-motion.
 */
const CONFETTI = Array.from({ length: 36 }, (_, i) => ({
  x: (i * 137) % 100,          // horizontal start, spread across the card
  delay: (((i * 89) % 100) / 100) * 1.6,
  rot: (i * 53) % 360,
  size: 6 + ((i * 31) % 8),
  color: i % 3,
}));

export function Result({ state, onReveal, onRematch, busy }) {
  if (!state?.winner) return null;
  const youWon = state.winner === SEAT.YOU;

  return (
    <aside className={`result ${youWon ? 'result--win' : 'result--loss'}`} role="status">
      {youWon ? (
        <span className="confetti" aria-hidden="true">
          {CONFETTI.map((p, i) => (
            <i
              key={i}
              className={`confetti__piece confetti__piece--c${p.color}`}
              style={{
                '--x': `${p.x}%`,
                '--d': `${p.delay.toFixed(2)}s`,
                '--r': `${p.rot}deg`,
                '--s': `${p.size}px`,
              }}
            />
          ))}
        </span>
      ) : null}
      <h2>{youWon ? 'Fleet sunk. You win.' : 'Your fleet is gone.'}</h2>
      <p className="muted">
        Every hit this match was answered against a fleet committed before the first shot.
      </p>
      <div className="result__actions">
        {!state.revealed ? (
          <MagneticButton className="btn btn--primary" onClick={onReveal} disabled={busy}>
            Reveal &amp; audit
          </MagneticButton>
        ) : (
          <span className="chip chip--ok">✓ boards opened — commitments match</span>
        )}
        <button type="button" className="btn" onClick={onRematch} disabled={busy}>Rematch</button>
      </div>
    </aside>
  );
}
