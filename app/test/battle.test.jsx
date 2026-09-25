// The battle screen and the end-of-game card, tested directly (docs/14
// section 1: the frontend layer covers components and state transitions, and
// docs/14 section 5 asks for the core game flow plus error states).
//
// The two things worth pinning here are the fog rule and the error surface:
// the enemy board can only ever draw what the marks array says, because the
// opponent fleet arrives as null until revealFleets() - and a driver refusal
// must reach the player as a readable alert, not a silent stall.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Battle } from '../src/components/Battle.jsx';
import { Result } from '../src/components/Result.jsx';
import { GRID_CELLS, MARK, PHASE, SEAT } from '../src/game/protocol.js';

const FLEET = [0, 1, 2, 8, 16, 24, 32]; // one legal 7-cell layout is enough here

function makeState(overrides = {}) {
  return {
    phase: PHASE.PLAYING,
    turn: SEAT.YOU,
    winner: null,
    fleetCells: 7,
    difficulty: 'standard',
    seed: 1,
    yourCommitment: 'a'.repeat(64),
    opponentCommitment: 'b'.repeat(64),
    you: { fleet: FLEET, marks: Array(GRID_CELLS).fill(MARK.UNKNOWN), hitsTaken: 0 },
    opponent: { fleet: null, marks: Array(GRID_CELLS).fill(MARK.UNKNOWN), hitsTaken: 0 },
    lastShot: null,
    revealed: false,
    ...overrides,
  };
}

function renderBattle(state, props = {}) {
  return render(
    <Battle
      state={state}
      info={{ name: 'local', provesMoves: false }}
      log={[]}
      narration={[]}
      busy={false}
      error={null}
      narrationOn={false}
      onToggleNarration={() => {}}
      onFire={props.onFire ?? (() => {})}
      onDismissError={props.onDismissError ?? (() => {})}
    />,
  );
}

describe('<Battle> error surface', () => {
  it('shows a driver refusal as an alert and dismisses it', async () => {
    const onDismissError = vi.fn();
    const state = makeState();
    const { rerender } = render(
      <Battle
        state={state}
        info={{ provesMoves: false }}
        log={[]}
        narration={[]}
        busy={false}
        error="not your turn"
        narrationOn={false}
        onToggleNarration={() => {}}
        onFire={() => {}}
        onDismissError={onDismissError}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('not your turn');

    await userEvent.click(within(alert).getByRole('button', { name: /dismiss/i }));
    expect(onDismissError).toHaveBeenCalledTimes(1);

    rerender(
      <Battle
        state={state}
        info={{ provesMoves: false }}
        log={[]}
        narration={[]}
        busy={false}
        error={null}
        narrationOn={false}
        onToggleNarration={() => {}}
        onFire={() => {}}
        onDismissError={onDismissError}
      />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('<Battle> fog rule', () => {
  it('renders every enemy cell as unknown while the opponent fleet is null', () => {
    renderBattle(makeState());
    const enemyGrid = screen.getByRole('grid', { name: /enemy waters/i });
    const cells = within(enemyGrid).getAllByRole('gridcell');
    const labels = cells.map((cell) => cell.getAttribute('aria-label'));
    expect(labels).toHaveLength(GRID_CELLS);
    expect(labels.every((label) => /unknown$/.test(label))).toBe(true);
    // your turn: every fog cell is a live target
    expect(cells.every((cell) => !cell.disabled)).toBe(true);
  });

  it('only captions the enemy board as revealed after the fleets are opened', () => {
    const state = makeState({ revealed: true, phase: PHASE.FINISHED, winner: SEAT.YOU });
    renderBattle(state);
    expect(screen.getByRole('grid', { name: /enemy waters — revealed/i })).toBeInTheDocument();
  });
});

describe('<Battle> turn gating', () => {
  it('lets you fire on your turn and ignores a cell you already fired at', async () => {
    const onFire = vi.fn();
    const marks = Array(GRID_CELLS).fill(MARK.UNKNOWN);
    marks[0] = MARK.HIT; // A1 already answered
    renderBattle(makeState({ opponent: { fleet: null, marks, hitsTaken: 1 } }), { onFire });

    const enemyGrid = screen.getByRole('grid', { name: /enemy waters/i });
    await userEvent.click(within(enemyGrid).getByRole('gridcell', { name: 'B1, unknown' }));
    expect(onFire).toHaveBeenCalledWith({ x: 1, y: 0 });

    await userEvent.click(within(enemyGrid).getByRole('gridcell', { name: 'A1, hit' }));
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('freezes the enemy board while the opponent is firing', () => {
    renderBattle(makeState({ turn: SEAT.OPPONENT }));
    const enemyGrid = screen.getByRole('grid', { name: /enemy waters/i });
    const cells = within(enemyGrid).getAllByRole('gridcell');
    expect(cells).toHaveLength(GRID_CELLS);
    expect(cells.every((cell) => cell.disabled)).toBe(true);
  });

  it('freezes the enemy board while a call is in flight', () => {
    const state = makeState();
    render(
      <Battle
        state={state}
        info={{ provesMoves: false }}
        log={[]}
        narration={[]}
        busy
        error={null}
        narrationOn={false}
        onToggleNarration={() => {}}
        onFire={() => {}}
        onDismissError={() => {}}
      />,
    );
    const enemyGrid = screen.getByRole('grid', { name: /enemy waters/i });
    const cells = within(enemyGrid).getAllByRole('gridcell');
    expect(cells.every((cell) => cell.disabled)).toBe(true);
  });
});

describe('<Battle> last-shot line and hit feedback (docs/18 section 2)', () => {
  it('prompts for a target before any shot', () => {
    renderBattle(makeState());
    expect(screen.getByText(/pick a cell on the enemy grid to fire/i)).toBeInTheDocument();
  });

  it('announces the latest shot with its coordinate, for both seats', () => {
    renderBattle(makeState({ lastShot: { seat: SEAT.YOU, coord: { x: 2, y: 1 }, result: 'hit' } }));
    expect(screen.getByText(/you fired/i).closest('p')).toHaveTextContent('C2 you fired → HIT');
  });

  it('flashes the screen edge on a hit and never on a miss', () => {
    const hit = renderBattle(makeState({ lastShot: { seat: SEAT.YOU, coord: { x: 2, y: 1 }, result: 'hit' } }));
    expect(hit.getByTestId('hit-flash')).toBeInTheDocument();
    hit.unmount();

    const miss = renderBattle(makeState({ lastShot: { seat: SEAT.OPPONENT, coord: { x: 0, y: 0 }, result: 'miss' } }));
    expect(miss.queryByTestId('hit-flash')).not.toBeInTheDocument();
    expect(miss.getByText(/they fired/i).closest('p')).toHaveTextContent('A1 they fired → MISS');
  });
});

describe('<Result>', () => {
  const finished = (winner, revealed = false) =>
    makeState({ phase: PHASE.FINISHED, winner, revealed });

  it('announces a win with the confetti burst kept out of the announcement', () => {
    render(<Result state={finished(SEAT.YOU)} onReveal={() => {}} onRematch={() => {}} busy={false} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Fleet sunk. You win.');
    const confetti = status.querySelector('.confetti');
    expect(confetti).not.toBeNull();
    expect(confetti.getAttribute('aria-hidden')).toBe('true');
  });

  it('announces a loss plainly, with no confetti', () => {
    render(<Result state={finished(SEAT.OPPONENT)} onReveal={() => {}} onRematch={() => {}} busy={false} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Your fleet is gone.');
    expect(status.querySelector('.confetti')).toBeNull();
  });

  it('offers reveal-and-audit exactly once: before the boards are opened', async () => {
    const onReveal = vi.fn();
    const { rerender } = render(
      <Result state={finished(SEAT.YOU)} onReveal={onReveal} onRematch={() => {}} busy={false} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /reveal & audit/i }));
    expect(onReveal).toHaveBeenCalledTimes(1);

    rerender(<Result state={finished(SEAT.YOU, true)} onReveal={onReveal} onRematch={() => {}} busy={false} />);
    expect(screen.queryByRole('button', { name: /reveal & audit/i })).not.toBeInTheDocument();
    expect(screen.getByText(/boards opened — commitments match/i)).toBeInTheDocument();
  });

  it('disables its actions while a call is in flight, and rematches when free', async () => {
    const onRematch = vi.fn();
    const { rerender } = render(
      <Result state={finished(SEAT.YOU)} onReveal={() => {}} onRematch={onRematch} busy />,
    );
    expect(screen.getByRole('button', { name: /reveal & audit/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /rematch/i })).toBeDisabled();

    rerender(<Result state={finished(SEAT.YOU)} onReveal={() => {}} onRematch={onRematch} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: /rematch/i }));
    expect(onRematch).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while the game is still on', () => {
    const { container } = render(
      <Result state={makeState()} onReveal={() => {}} onRematch={() => {}} busy={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
describe('<Battle> fire ripple (docs/18 section 2)', () => {
  it('ripples the fired cell while the answer is in flight', async () => {
    const onFire = vi.fn();
    renderBattle(makeState(), { onFire });
    expect(screen.queryByTestId('fire-ripple')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('cell-enemy-B2'));
    expect(onFire).toHaveBeenCalledWith({ x: 1, y: 1 });
    const ripple = screen.getByTestId('fire-ripple');
    expect(within(screen.getByTestId('cell-enemy-B2')).getByTestId('fire-ripple')).toBe(ripple);
  });

  it('is decorative and clears as soon as the answer lands', async () => {
    const state = makeState();
    const { rerender } = renderBattle(state);
    await userEvent.click(screen.getByTestId('cell-enemy-B2'));
    const ripple = screen.getByTestId('fire-ripple');
    expect(ripple).toHaveAttribute('aria-hidden', 'true');

    const marks = Array(GRID_CELLS).fill(MARK.UNKNOWN);
    marks[9] = MARK.MISS;
    const answered = makeState({
      opponent: { fleet: null, marks, hitsTaken: 0 },
      lastShot: { seat: SEAT.YOU, coord: { x: 1, y: 1 }, result: 'miss' },
    });
    rerender(
      <Battle
        state={answered}
        info={{ name: 'local', provesMoves: false }}
        log={[]}
        narration={[]}
        busy={false}
        error={null}
        narrationOn={false}
        onToggleNarration={() => {}}
        onFire={() => {}}
        onDismissError={() => {}}
      />,
    );
    expect(screen.queryByTestId('fire-ripple')).not.toBeInTheDocument();
    expect(screen.getByTestId('cell-enemy-B2')).toHaveAttribute('aria-label', 'B2, miss');
  });

  it('never ripples a cell that was already answered', async () => {
    const marks = Array(GRID_CELLS).fill(MARK.UNKNOWN);
    marks[0] = MARK.HIT;
    const onFire = vi.fn();
    renderBattle(makeState({ opponent: { fleet: null, marks, hitsTaken: 1 } }), { onFire });
    await userEvent.click(screen.getByTestId('cell-enemy-A1'));
    expect(onFire).not.toHaveBeenCalled();
    expect(screen.queryByTestId('fire-ripple')).not.toBeInTheDocument();
  });

  it('clears the ripple if the driver refuses the shot', async () => {
    const state = makeState();
    const { rerender } = renderBattle(state);
    await userEvent.click(screen.getByTestId('cell-enemy-B2'));
    expect(screen.getByTestId('fire-ripple')).toBeInTheDocument();
    rerender(
      <Battle
        state={state}
        info={{ name: 'local', provesMoves: false }}
        log={[]}
        narration={[]}
        busy={false}
        error="not your turn"
        narrationOn={false}
        onToggleNarration={() => {}}
        onFire={() => {}}
        onDismissError={() => {}}
      />,
    );
    expect(screen.queryByTestId('fire-ripple')).not.toBeInTheDocument();
  });
});
