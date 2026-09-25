import { useEffect, useRef, useState } from 'react';
import { PHASE, SEAT } from '../game/protocol.js';
import { Hash, Identicon } from './Hash.jsx';

function Meter({ label, value, total }) {
  return (
    <div className="meter">
      <span className="meter__label">{label}</span>
      <span className="meter__track" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <i key={i} className={i < value ? 'on' : ''} />
        ))}
      </span>
      <span className="mono meter__count">{value}/{total}</span>
    </div>
  );
}


/**
 * Live status stepper for the answer pipeline (docs/18 section 3), rendered
 * as the multi-step loader from the docs/18 section 4 kit: steps check off in
 * order while the driver works; when it settles, a short confirmation pulse. The wording follows the driver: a proof-backed driver
 * talks about proofs and the ledger, the local driver does not - claiming a
 * proof that was never generated would be a lie, not polish.
 */
const STEP_MS = 900;

function Stepper({ busy, provesMoves }) {
  const [settled, setSettled] = useState(false);
  const [active, setActive] = useState(0);
  const wasBusy = useRef(false);

  const steps = provesMoves ? ['proving', 'submitting', 'confirming'] : ['checking rules', 'applying'];

  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      setSettled(false);
      setActive(0);
      // Multi-step loader (docs/18 section 4): steps check off in order while
      // the driver works, and the last one stays current until it finishes -
      // the loader never claims a step the driver has not reported.
      const timer = setInterval(() => {
        setActive((a) => Math.min(a + 1, steps.length - 1));
      }, STEP_MS);
      return () => clearInterval(timer);
    }
    if (!wasBusy.current) return undefined;
    wasBusy.current = false;
    setSettled(true);
    const timer = setTimeout(() => setSettled(false), 2400);
    return () => clearTimeout(timer);
  }, [busy, steps.length]);

  if (busy) {
    return (
      <span
        className="stepper"
        role="status"
        aria-label={provesMoves ? 'Generating proof and submitting' : 'Resolving the last action'}
      >
        {steps.map((label, i) => (
          <span
            key={label}
            className={`stepper__step${i < active ? ' stepper__step--done' : i === active ? ' stepper__step--current' : ''}`}
          >
            <i className="stepper__dot" aria-hidden="true">{i < active ? '\u2713' : ''}</i>
            {label}
          </span>
        ))}
      </span>
    );
  }
  if (settled) {
    return (
      <span className={`stepper stepper--settled${provesMoves ? ' stepper--onchain' : ''}`} role="status">
        {provesMoves ? '🔒 confirmed on-chain' : '✓ resolved'}
      </span>
    );
  }
  return null;
}

/**
 * The persistent strip: whose turn, how the fleets are doing, what is backing
 * the game, and the honest "what is proven right now" chip.
 */
export function Hud({ state, info, busy }) {
  const [openWhy, setOpenWhy] = useState(false);
  if (!state) return null;

  const turnText = state.winner
    ? (state.winner === SEAT.YOU ? 'You won' : 'Opponent won')
    : state.phase !== PHASE.PLAYING
      ? 'Setting up'
      : state.turn === SEAT.YOU ? 'Your turn — fire' : 'Opponent firing…';

  return (
    <div className="hud">
      <div className="hud__turn">
        <span className={`dot ${state.turn === SEAT.YOU ? 'dot--live' : ''}`} aria-hidden="true" />
        <strong>{busy ? 'Resolving…' : turnText}</strong>
        <Stepper busy={busy} provesMoves={!!info?.provesMoves} />
      </div>

      <div className="hud__meters">
        <Meter label="Hits on them" value={state.opponent.hitsTaken} total={state.fleetCells} />
        <Meter label="Hits on you" value={state.you.hitsTaken} total={state.fleetCells} />
      </div>

      <div className="hud__chain">
        <span className="chip" title={info?.summary}>
          {info?.provesMoves ? '🔒 proof-backed' : '◇ local rules'} · {info?.name ?? 'driver'}
        </span>
        <span className="hud__hashes">
          <span>yours <Identicon value={state.yourCommitment} label="your" /><Hash value={state.yourCommitment} /></span>
          <span>theirs <Identicon value={state.opponentCommitment} label="their" /><Hash value={state.opponentCommitment} /></span>
        </span>
        <button
          type="button"
          className="btn btn--tiny"
          aria-expanded={openWhy}
          onClick={() => setOpenWhy((v) => !v)}
        >
          Why can&apos;t they cheat?
        </button>
      </div>

      {openWhy ? (
        <div className="hud__why" role="note">
          <p>
            Before the first shot each side publishes a hash of its fleet. Every answer after
            that has to match that hash, so a ship cannot be moved out of the way mid-game. The
            only thing an answer ever reveals is hit-or-miss for the single cell you fired at.
          </p>
          <p className="muted small">
            {info?.provesMoves
              ? 'This game is answering with real zero-knowledge proofs.'
              : 'This session runs the rules locally in your browser — the same rules the ' +
                'Compact contract enforces, but no proof is generated and nothing is on a ledger.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
