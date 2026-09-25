import { useState } from 'react';
import { Hash } from './Hash.jsx';
import { useGlow } from './Glow.jsx';

/**
 * Proof inspector: an expandable card that splits every
 * game into what went in (public) and what stayed private. The toggle between
 * the two panes carries a sliding-thumb animation; panes fade in with the
 * shared `rise` keyframes.
 *
 * Honesty rule, same as the HUD stepper: the wording follows the driver. A
 * proof-backed driver talks about proofs and the ledger; the local driver
 * says the rules ran in this browser and no proof exists. Claiming a proof
 * that was never generated would be a lie, not polish.
 */
export function Inspector({ state, log, provesMoves }) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState('public');
  const glow = useGlow();
  if (!state) return null;

  const answers = (log ?? []).filter((e) => e.result).length;

  return (
    <section
      ref={glow.ref}
      onPointerMove={glow.onPointerMove}
      onPointerLeave={glow.onPointerLeave}
      className="panel inspector glow"
      aria-label="Proof inspector"
      data-testid="inspector"
    >
      <header className="panel__head panel__head--tight">
        <button
          type="button"
          className="inspector__title"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          What&apos;s public, what&apos;s hidden
        </button>
        <span className="muted small">{open ? '' : 'tap to open'}</span>
      </header>

      {open ? (
        <div className="inspector__body">
          <div className="inspector__toggle" role="group" aria-label="Choose the public or private view">
            <span className={`inspector__thumb${pane === 'private' ? ' inspector__thumb--private' : ''}`} aria-hidden="true" />
            <button
              type="button"
              className="inspector__opt"
              aria-pressed={pane === 'public'}
              onClick={() => setPane('public')}
            >
              public
            </button>
            <button
              type="button"
              className="inspector__opt"
              aria-pressed={pane === 'private'}
              onClick={() => setPane('private')}
            >
              private
            </button>
          </div>

          {pane === 'public' ? (
            <div className="inspector__pane" data-testid="inspector-public" role="region" aria-label="What is public">
              <ul>
                <li>Both fleet commitments: yours <Hash value={state.yourCommitment} />, theirs <Hash value={state.opponentCommitment} /></li>
                <li>{answers} {answers === 1 ? 'answer' : 'answers'} published - every coordinate with its hit or miss</li>
                <li>Whose turn it is, and the winner when the game ends</li>
              </ul>
            </div>
          ) : (
            <div className="inspector__pane" data-testid="inspector-private" role="region" aria-label="What stays private">
              <ul>
                <li>Your fleet layout - only its commitment hash is public</li>
                <li>Your salt - the secret that opens your commitment at reveal</li>
                <li>Their fleet layout and salt - you only hold their hash</li>
              </ul>
              <p className="muted small">
                {provesMoves
                  ? 'Answers are proven in zero knowledge: only the proof leaves this machine, never the fleet.'
                  : 'This session runs the rules locally in your browser - no proof is generated and nothing is on a ledger.'}
              </p>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
