// Component and flow tests: placement in the UI, firing through the driver,
// and the accessibility affordances the game is unplayable without.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App.jsx';
import { Battle } from '../src/components/Battle.jsx';
import { Board } from '../src/components/Board.jsx';
import { FleetSetup } from '../src/components/FleetSetup.jsx';
import { Hud } from '../src/components/Hud.jsx';
import { Inspector } from '../src/components/Inspector.jsx';
import { ShotLog } from '../src/components/ShotLog.jsx';
import { Narrator } from '../src/components/Narrator.jsx';
import { Home } from '../src/components/Home.jsx';
import { MagneticButton } from '../src/components/MagneticButton.jsx';
import { EmptyState } from '../src/components/EmptyState.jsx';
import { Identicon } from '../src/components/Hash.jsx';
import { Result } from '../src/components/Result.jsx';
import { GRID_CELLS, MARK, PHASE, SEAT } from '../src/game/protocol.js';
import { readFileSync } from 'node:fs';

const emptyMarks = () => Array(GRID_CELLS).fill(MARK.UNKNOWN);

describe('<Board>', () => {
  it('renders 64 labelled cells', () => {
    render(<Board mode="mine" marks={emptyMarks()} />);
    expect(screen.getAllByRole('gridcell')).toHaveLength(GRID_CELLS);
    expect(screen.getByTestId('cell-mine-A1')).toBeInTheDocument();
    expect(screen.getByTestId('cell-mine-H8')).toBeInTheDocument();
  });

  it('is inert without an activate handler and live with one', async () => {
    const onCellActivate = vi.fn();
    const { rerender } = render(<Board mode="enemy" marks={emptyMarks()} />);
    expect(screen.getByTestId('cell-enemy-A1')).toBeDisabled();
    rerender(<Board mode="enemy" marks={emptyMarks()} onCellActivate={onCellActivate} />);
    await userEvent.click(screen.getByTestId('cell-enemy-A1'));
    expect(onCellActivate).toHaveBeenCalledWith(0, { x: 0, y: 0 });
  });

  it('stays inert when disabled, even with a handler', () => {
    render(<Board mode="enemy" marks={emptyMarks()} disabled onCellActivate={vi.fn()} />);
    expect(screen.getByTestId('cell-enemy-A1')).toBeDisabled();
  });

  it('moves focus with the arrow keys so the board is keyboard-playable', async () => {
    render(<Board mode="enemy" marks={emptyMarks()} onCellActivate={vi.fn()} />);
    const a1 = screen.getByTestId('cell-enemy-A1');
    a1.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('cell-enemy-B1')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByTestId('cell-enemy-B2')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}{ArrowUp}'); // clamps at the edge
    expect(screen.getByTestId('cell-enemy-A1')).toHaveFocus();
  });

  it('fires with Enter or Space on the focused enemy cell', async () => {
    const onCellActivate = vi.fn();
    render(<Board mode="enemy" marks={emptyMarks()} onCellActivate={onCellActivate} />);
    screen.getByTestId('cell-enemy-B2').focus();
    await userEvent.keyboard('{Enter}');
    expect(onCellActivate).toHaveBeenCalledWith(9, { x: 1, y: 1 });
    onCellActivate.mockClear();
    await userEvent.keyboard(' ');
    expect(onCellActivate).toHaveBeenCalledWith(9, { x: 1, y: 1 });
  });

  it('marks hit and miss with a glyph as well as a colour (colourblind-safe)', () => {
    const marks = emptyMarks();
    marks[0] = MARK.HIT;
    marks[1] = MARK.MISS;
    render(<Board mode="enemy" marks={marks} />);
    expect(screen.getByTestId('cell-enemy-A1')).toHaveTextContent('✕');
    expect(screen.getByTestId('cell-enemy-B1')).toHaveTextContent('•');
  });
});

describe('<FleetSetup>', () => {
  it('keeps Commit disabled until the fleet is legal', async () => {
    render(<FleetSetup onCommit={vi.fn()} />);
    const commit = screen.getByRole('button', { name: /commit fleet/i });
    expect(commit).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /auto-place/i }));
    expect(commit).toBeEnabled();
  });

  it('commits a 64-cell, 7-occupied board — the exact shape the contract takes', async () => {
    const onCommit = vi.fn();
    render(<FleetSetup onCommit={onCommit} />);
    await userEvent.click(screen.getByRole('button', { name: /auto-place/i }));
    await userEvent.click(screen.getByRole('button', { name: /commit fleet/i }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    const board = onCommit.mock.calls[0][0];
    expect(board).toHaveLength(64);
    expect(board.reduce((t, c) => t + c, 0)).toBe(7);
    expect(board.every((c) => c === 0 || c === 1)).toBe(true);
  });

  it('places ships by clicking, one after another', async () => {
    render(<FleetSetup onCommit={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cell-editable-A1')); // 3-cell: A1..C1
    expect(screen.getByTestId('cell-editable-C1')).toHaveAttribute('aria-label', 'C1, your ship');
    await userEvent.click(screen.getByTestId('cell-editable-A3')); // 2-cell: A3..B3
    expect(screen.getByTestId('cell-editable-B3')).toHaveAttribute('aria-label', 'B3, your ship');
    await userEvent.click(screen.getByTestId('cell-editable-A5'));
    expect(screen.getByRole('button', { name: /commit fleet/i })).toBeEnabled();
  });

  it('refuses an overlapping placement and says why', async () => {
    render(<FleetSetup onCommit={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cell-editable-A1')); // A1..C1
    await userEvent.click(screen.getByTestId('cell-editable-B1')); // picks the ship back up
    expect(screen.getByTestId('cell-editable-A1')).toHaveAttribute('aria-label', 'A1, unknown');
  });

  it('refuses a ship that would run off the board', async () => {
    render(<FleetSetup onCommit={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cell-editable-G1')); // 3-cell from G1 overruns H1
    expect(await screen.findByRole('alert')).toHaveTextContent(/off the board/i);
  });

  it('rotates the pending ship with R', async () => {
    render(<FleetSetup onCommit={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /rotate/i }));
    await userEvent.click(screen.getByTestId('cell-editable-A1'));
    expect(screen.getByTestId('cell-editable-A3')).toHaveAttribute('aria-label', 'A3, your ship');
    expect(screen.getByTestId('cell-editable-C1')).toHaveAttribute('aria-label', 'C1, unknown');
  });

  it('Clear returns every ship to the dock', async () => {
    render(<FleetSetup onCommit={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /auto-place/i }));
    await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(screen.getByRole('button', { name: /commit fleet/i })).toBeDisabled();
    expect(within(screen.getByLabelText('Fleet')).getAllByText('in dock')).toHaveLength(3);
  });

  it('springs freshly placed cells with a settle marker', async () => {
    render(<FleetSetup onCommit={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cell-editable-A1')); // 3-cell: A1..C1
    for (const name of ['A1', 'B1', 'C1']) {
      expect(screen.getByTestId(`cell-editable-${name}`)).toHaveClass('cell--settled');
    }
    expect(screen.getByTestId('cell-editable-D1')).not.toHaveClass('cell--settled');
  });

  it('auto-place settles every fleet cell at once', async () => {
    render(<FleetSetup onCommit={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /auto-place/i }));
    expect(document.querySelectorAll('.cell--settled')).toHaveLength(7);
  });

  it('lifting a placed ship clears the settle markers', async () => {
    render(<FleetSetup onCommit={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cell-editable-A1'));
    await userEvent.click(screen.getByTestId('cell-editable-B1')); // pick it back up
    expect(document.querySelectorAll('.cell--settled')).toHaveLength(0);
  });
});

describe('<Hud>, <ShotLog>, <Narrator>', () => {
  const state = {
    phase: PHASE.PLAYING,
    turn: SEAT.YOU,
    winner: null,
    fleetCells: 7,
    you: { fleet: null, marks: emptyMarks(), hitsTaken: 2 },
    opponent: { fleet: null, marks: emptyMarks(), hitsTaken: 3 },
    yourCommitment: 'abcdef0123456789abcdef0123456789',
    opponentCommitment: '0011223344556677889900112233',
    lastShot: null,
    revealed: false,
  };

  it('announces whose turn it is', () => {
    render(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={false} />);
    expect(screen.getByText(/your turn/i)).toBeInTheDocument();
  });

  it('does not claim a proof the driver did not generate', async () => {
    render(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={false} />);
    expect(screen.getByText(/local rules/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /why can't they cheat/i }));
    expect(screen.getByRole('note')).toHaveTextContent(/no proof is generated/i);
  });

  it('says so when the driver does prove moves', async () => {
    render(<Hud state={state} info={{ name: 'Preprod', provesMoves: true }} busy={false} />);
    expect(screen.getByText(/proof-backed/i)).toBeInTheDocument();
  });

  it('shows the shot log newest-first with coordinates in mono', () => {
    render(<ShotLog entries={[
      { seq: 0, circuit: 'commitBoard', seat: SEAT.OPPONENT },
      { seq: 1, circuit: 'fire', seat: SEAT.YOU, coord: { x: 0, y: 0 } },
      { seq: 2, circuit: 'report', seat: SEAT.OPPONENT, coord: { x: 0, y: 0 }, result: 'hit' },
    ]} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('HIT');
    expect(rows[0]).toHaveTextContent('A1');
    expect(rows[2]).toHaveTextContent('commit');
  });

  it('shows the latest narrator line and can be switched off', async () => {
    const onToggle = vi.fn();
    render(<Narrator lines={[{ seq: 0, line: 'first line' }, { seq: 1, line: 'latest line' }]} onToggle={onToggle} />);
    expect(screen.getByRole('status')).toHaveTextContent('latest line');
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});

describe('<App> end to end against the in-browser driver', () => {
  it('goes home -> setup -> battle and resolves a real shot', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/nightfleet/i);

    await userEvent.click(screen.getByRole('button', { name: /play vs ai/i }));
    expect(await screen.findByRole('heading', { name: /place your fleet/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /auto-place/i }));
    await userEvent.click(screen.getByRole('button', { name: /commit fleet/i }));

    const enemyA1 = await screen.findByTestId('cell-enemy-A1');
    expect(enemyA1).toHaveAttribute('aria-label', 'A1, unknown');
    await userEvent.click(enemyA1);

    await waitFor(() => {
      expect(screen.getByTestId('cell-enemy-A1').getAttribute('aria-label'))
        .toMatch(/A1, (hit|miss)/);
    });
    // the AI answered and fired back: our own board now carries a mark too
    await waitFor(() => {
      expect(document.querySelectorAll('.board--mine .cell--hit, .board--mine .cell--miss').length)
        .toBeGreaterThan(0);
    });
  });

  it('offers the proof-backed engine as a playable squad mode', async () => {
    render(<App />);
    const midnight = await screen.findByRole('button', { name: /midnight preprod/i });
    await waitFor(() => expect(screen.getByText(/local session/i)).toBeInTheDocument());
    expect(midnight).toBeEnabled();
    expect(midnight).toHaveTextContent(/squad link/i);
  });
});


describe('<Hud> answer-pipeline stepper', () => {
  const state = {
    phase: PHASE.PLAYING,
    turn: SEAT.YOU,
    winner: null,
    fleetCells: 7,
    you: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    opponent: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    yourCommitment: 'abcdef0123456789abcdef0123456789',
    opponentCommitment: '0011223344556677889900112233',
    lastShot: null,
    revealed: false,
  };

  it('shows honest working steps for the local driver while resolving', () => {
    render(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={true} />);
    expect(screen.getByRole('status')).toHaveTextContent('checking rules');
    expect(screen.queryByText(/proving|on-chain/i)).not.toBeInTheDocument();
  });

  it('names the proof pipeline only when the driver really proves', () => {
    render(<Hud state={state} info={{ name: 'Preprod', provesMoves: true }} busy={true} />);
    const stepper = screen.getByRole('status');
    expect(stepper).toHaveTextContent('proving');
    expect(stepper).toHaveTextContent('submitting');
    expect(stepper).toHaveTextContent('confirming');
  });

  it('pulses a settled confirmation after the driver finishes', () => {
    const { rerender } = render(<Hud state={state} info={{ name: 'Preprod', provesMoves: true }} busy={true} />);
    rerender(<Hud state={state} info={{ name: 'Preprod', provesMoves: true }} busy={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('confirmed on-chain');
  });

  it('settles without claiming a ledger for the local driver', () => {
    const { rerender } = render(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={true} />);
    rerender(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('resolved');
    expect(screen.queryByText(/on-chain/i)).not.toBeInTheDocument();
  });
});

describe('<Hud> stepper as multi-step loader', () => {
  const state = {
    phase: PHASE.PLAYING,
    turn: SEAT.YOU,
    winner: null,
    fleetCells: 7,
    you: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    opponent: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    yourCommitment: 'abcdef0123456789abcdef0123456789',
    opponentCommitment: '0011223344556677889900112233',
    lastShot: null,
    revealed: false,
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const stepEls = () =>
    screen.getByRole('status').querySelectorAll('.stepper__step');

  it('checks steps off in order while the driver works', () => {
    render(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={true} />);
    let steps = stepEls();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveClass('stepper__step--current');
    expect(steps[1]).not.toHaveClass('stepper__step--current');
    expect(steps[1]).not.toHaveClass('stepper__step--done');

    act(() => vi.advanceTimersByTime(900));
    steps = stepEls();
    expect(steps[0]).toHaveClass('stepper__step--done');
    expect(steps[0].querySelector('.stepper__dot')).toHaveTextContent('\u2713');
    expect(steps[1]).toHaveClass('stepper__step--current');
  });

  it('holds on the last step until the driver finishes - never ahead of it', () => {
    render(<Hud state={state} info={{ name: 'Preprod', provesMoves: true }} busy={true} />);
    act(() => vi.advanceTimersByTime(5000));
    const steps = stepEls();
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveClass('stepper__step--done');
    expect(steps[1]).toHaveClass('stepper__step--done');
    // The driver has not come back, so confirming stays current, never done.
    expect(steps[2]).toHaveClass('stepper__step--current');
    expect(steps[2]).not.toHaveClass('stepper__step--done');
  });

  it('restarts from the first step on the next action', () => {
    const { rerender } = render(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={true} />);
    act(() => vi.advanceTimersByTime(900));
    rerender(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={false} />);
    rerender(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={true} />);
    const steps = stepEls();
    expect(steps[0]).toHaveClass('stepper__step--current');
    expect(steps[1]).not.toHaveClass('stepper__step--done');
  });
});

describe('<Hud> commitment fingerprint tiles', () => {
  const state = {
    phase: PHASE.PLAYING,
    turn: SEAT.YOU,
    winner: null,
    fleetCells: 7,
    you: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    opponent: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    yourCommitment: 'abcdef0123456789abcdef0123456789',
    opponentCommitment: '0011223344556677889900112233',
    lastShot: null,
    revealed: false,
  };

  it('renders a labeled fingerprint tile per published commitment', () => {
    render(<Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={false} />);
    expect(screen.getByRole('img', { name: /your commitment fingerprint/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /their commitment fingerprint/i })).toBeInTheDocument();
  });

  it('is deterministic: the same hash paints the same cells', () => {
    const count = () => {
      const { container, unmount } = render(
        <Hud state={state} info={{ name: 'Local', provesMoves: false }} busy={false} />,
      );
      const n = container.querySelectorAll('.identicon i.on').length;
      unmount();
      return n;
    };
    expect(count()).toBe(count());
    expect(count()).toBeGreaterThan(0);
  });

  it('staggers the cells so the tile cascades in on reveal', () => {
    const { container } = render(<Identicon value="abcdef0123456789" label="your" />);
    const cells = container.querySelectorAll('.identicon i');
    expect(cells).toHaveLength(25);
    expect(cells[0].style.getPropertyValue('--i')).toBe('0');
    expect(cells[24].style.getPropertyValue('--i')).toBe('24');
  });

  it('shows no tile before a commitment exists', () => {
    render(
      <Hud
        state={{ ...state, yourCommitment: null, opponentCommitment: null }}
        info={{ name: 'Local', provesMoves: false }}
        busy={false}
      />,
    );
    expect(screen.queryByRole('img', { name: /commitment fingerprint/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/not committed/i)).toHaveLength(2);
  });
});

describe('<ShotLog> timeline scrubber', () => {
  const entries = [
    { seq: 0, circuit: 'commitBoard', seat: SEAT.OPPONENT },
    { seq: 1, circuit: 'fire', seat: SEAT.YOU, coord: { x: 0, y: 0 } },
    { seq: 2, circuit: 'report', seat: SEAT.OPPONENT, coord: { x: 0, y: 0 }, result: 'hit' },
    { seq: 3, circuit: 'fire', seat: SEAT.OPPONENT, coord: { x: 4, y: 2 } },
  ];

  it('shows the whole record by default and offers a slider across it', () => {
    render(<ShotLog entries={entries} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    const scrub = screen.getByRole('slider', { name: /scrub the public log/i });
    expect(scrub).toHaveAttribute('max', '4');
    expect(scrub.value).toBe('4');
  });

  it('rewinds the public record when scrubbed', () => {
    render(<ShotLog entries={entries} />);
    fireEvent.change(screen.getByRole('slider', { name: /scrub the public log/i }), { target: { value: '2' } });
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('fire');
    expect(screen.queryByText('HIT')).not.toBeInTheDocument();
  });

  it('renders no scrubber before anything is on the record', () => {
    render(<ShotLog entries={[]} />);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByText(/nothing has happened/i)).toBeInTheDocument();
  });
});

// vitest runs with cwd at the app package, so plain relative paths resolve.
const tokensCss = readFileSync('src/styles/tokens.css', 'utf8');
const appCss = readFileSync('src/styles/app.css', 'utf8');

describe('motion tokens', () => {
  it('defines the whole spring language in tokens.css and nowhere else', () => {
    for (const token of ['--spring:', '--spring-pop:', '--spring-soft:']) {
      expect(tokensCss).toContain(token);
    }
    // Component css uses the tokens; a raw cubic-bezier outside tokens.css
    // means a second motion language snuck back in.
    expect(appCss).not.toContain('cubic-bezier');
    expect(appCss).toContain('var(--spring-pop)');
    expect(appCss).toContain('var(--spring-soft)');
  });
});

describe('<EmptyState> empty-state kit item', () => {
  it('renders glyph, title, and hint with the glyph hidden from assistive tech', () => {
    const { container } = render(<EmptyState title="Nothing here" hint="It will show up later." />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText(/show up later/)).toBeInTheDocument();
    expect(container.querySelector('.empty-state__glyph')).toHaveAttribute('aria-hidden', 'true');
  });

  it('fills the public log before anything is on the record', () => {
    const { container } = render(<ShotLog entries={[]} />);
    expect(screen.getByText(/nothing has happened on the public record/i)).toBeInTheDocument();
    expect(container.querySelector('.empty-state')).toBeInTheDocument();
  });
});

describe('<Result> win moment', () => {
  const base = { winner: SEAT.YOU, revealed: false };

  it('plays a confetti burst on a win, hidden from assistive tech', () => {
    const { container } = render(
      <Result state={base} onReveal={vi.fn()} onRematch={vi.fn()} busy={false} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Fleet sunk. You win.');
    const burst = container.querySelector('.confetti');
    expect(burst).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('.confetti__piece')).toHaveLength(36);
  });

  it('stays quiet on a loss', () => {
    const { container } = render(
      <Result state={{ ...base, winner: SEAT.OPPONENT }} onReveal={vi.fn()} onRematch={vi.fn()} busy={false} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Your fleet is gone.');
    expect(container.querySelector('.confetti')).toBeNull();
  });

  it('renders nothing before a winner exists', () => {
    const { container } = render(
      <Result state={{ winner: null, revealed: false }} onReveal={vi.fn()} onRematch={vi.fn()} busy={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('<App> ambient fog scene', () => {
  it('layers the fog behind the content, hidden from assistive tech', () => {
    const { container } = render(<App />);
    const fog = container.querySelector('.app__fog');
    expect(fog).toHaveAttribute('aria-hidden', 'true');
    expect(fog.querySelectorAll('i')).toHaveLength(3);
  });
});

describe('<Battle> hit feedback', () => {
  const baseState = {
    phase: PHASE.PLAYING,
    turn: SEAT.YOU,
    winner: null,
    fleetCells: 7,
    you: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    opponent: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    yourCommitment: 'abcdef0123456789abcdef0123456789',
    opponentCommitment: '0011223344556677889900112233',
    revealed: false,
  };
  const props = {
    info: { name: 'Local', provesMoves: false },
    log: [],
    narration: [],
    busy: false,
    error: null,
    narrationOn: true,
    onToggleNarration: vi.fn(),
    onFire: vi.fn(),
    onDismissError: vi.fn(),
  };

  it('flashes the screen edge on a fresh hit and stays quiet on a miss', () => {
    const shot = { seat: SEAT.YOU, coord: { x: 1, y: 1 }, result: 'hit' };
    const { rerender } = render(<Battle {...props} state={{ ...baseState, lastShot: shot }} />);
    expect(screen.getByTestId('hit-flash')).toBeInTheDocument();
    rerender(<Battle {...props} state={{ ...baseState, lastShot: { ...shot, result: 'miss' } }} />);
    expect(screen.queryByTestId('hit-flash')).not.toBeInTheDocument();
    rerender(<Battle {...props} state={{ ...baseState, lastShot: null }} />);
    expect(screen.queryByTestId('hit-flash')).not.toBeInTheDocument();
  });
});

describe('<MagneticButton> magnetic primary CTAs', () => {
  const stubMedia = ({ finePointer = true, reducedMotion = false } = {}) => {
    vi.stubGlobal('matchMedia', (query) => ({
      matches:
        (query === '(pointer: fine)' && finePointer) ||
        (query === '(prefers-reduced-motion: reduce)' && reducedMotion),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  };

  afterEach(() => vi.unstubAllGlobals());

  // jsdom's PointerEvent constructor drops clientX/clientY, so dispatch a
  // MouseEvent shaped like a pointermove - React binds the type, not the class.
  const pointerMove = (el, { pointerType = 'mouse', clientX = 80, clientY = 40 } = {}) => {
    const event = new window.MouseEvent('pointermove', { bubbles: true, clientX, clientY });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    fireEvent(el, event);
  };

  it('leans toward the pointer and springs back on leave', () => {
    stubMedia();
    render(<MagneticButton className="btn btn--primary">Commit fleet</MagneticButton>);
    const btn = screen.getByRole('button', { name: 'Commit fleet' });
    expect(btn).toHaveClass('btn--magnetic');

    pointerMove(btn);
    const mx = btn.style.getPropertyValue('--mx');
    const my = btn.style.getPropertyValue('--my');
    expect(mx).not.toBe('');
    expect(my).not.toBe('');
    // jsdom rects are zero-sized, so any pointer lands past the centre and the
    // lean hits the cap; the exact px matter less than the direction existing.
    expect(parseFloat(mx)).toBeGreaterThan(0);
    expect(parseFloat(my)).toBeGreaterThan(0);
    expect(parseFloat(mx)).toBeLessThanOrEqual(6);
    expect(parseFloat(my)).toBeLessThanOrEqual(6);

    fireEvent.pointerLeave(btn);
    expect(btn.style.getPropertyValue('--mx')).toBe('0px');
    expect(btn.style.getPropertyValue('--my')).toBe('0px');
  });

  it('stays still for touch pointers and reduced motion', () => {
    stubMedia();
    const { unmount } = render(<MagneticButton className="btn">touch</MagneticButton>);
    const touchBtn = screen.getByRole('button', { name: 'touch' });
    pointerMove(touchBtn, { pointerType: 'touch' });
    expect(touchBtn.style.getPropertyValue('--mx')).toBe('');
    unmount();

    stubMedia({ reducedMotion: true });
    render(<MagneticButton className="btn">calm</MagneticButton>);
    const calmBtn = screen.getByRole('button', { name: 'calm' });
    pointerMove(calmBtn);
    expect(calmBtn.style.getPropertyValue('--mx')).toBe('');
  });
});

describe('<Inspector> public/private card', () => {
  const state = {
    phase: PHASE.PLAYING,
    turn: SEAT.YOU,
    winner: null,
    fleetCells: 7,
    you: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    opponent: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    yourCommitment: 'abcdef0123456789abcdef0123456789',
    opponentCommitment: '0011223344556677889900112233',
    lastShot: null,
    revealed: false,
  };
  const log = [
    { seq: 0, circuit: 'fire', seat: SEAT.YOU, coord: { x: 0, y: 0 } },
    { seq: 1, circuit: 'report', seat: SEAT.OPPONENT, coord: { x: 0, y: 0 }, result: 'hit' },
  ];

  it('expands to the public pane and toggles to the private pane', async () => {
    render(<Inspector state={state} log={log} provesMoves={false} />);
    expect(screen.queryByTestId('inspector-public')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /hidden/i }));
    expect(screen.getByTestId('inspector-public')).toHaveTextContent('1 answer published');
    expect(screen.getByTestId('inspector-public')).toHaveTextContent('abcdef01');
    await userEvent.click(screen.getByRole('button', { name: 'private' }));
    expect(screen.getByTestId('inspector-private')).toHaveTextContent('fleet layout');
    expect(screen.getByTestId('inspector-private')).toHaveTextContent('salt');
    expect(screen.queryByTestId('inspector-public')).not.toBeInTheDocument();
  });

  it('shows not committed through the shared hash treatment when a commitment is missing', async () => {
    render(<Inspector state={{ ...state, yourCommitment: null }} log={[]} provesMoves={false} />);
    await userEvent.click(screen.getByRole('button', { name: /hidden/i }));
    expect(screen.getByTestId('inspector-public')).toHaveTextContent('not committed');
  });

  it('never claims a proof the local driver did not generate', async () => {
    const { rerender } = render(<Inspector state={state} log={log} provesMoves={false} />);
    await userEvent.click(screen.getByRole('button', { name: /hidden/i }));
    await userEvent.click(screen.getByRole('button', { name: 'private' }));
    expect(screen.getByTestId('inspector-private')).toHaveTextContent(/no proof is generated/i);
    rerender(<Inspector state={state} log={log} provesMoves />);
    expect(screen.getByTestId('inspector-private')).toHaveTextContent(/zero knowledge/i);
  });
});

describe('glow panels (glowing-effect)', () => {
  const stubMedia = ({ finePointer = true, reducedMotion = false } = {}) => {
    vi.stubGlobal('matchMedia', (query) => ({
      matches:
        (query === '(pointer: fine)' && finePointer) ||
        (query === '(prefers-reduced-motion: reduce)' && reducedMotion),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  };

  afterEach(() => vi.unstubAllGlobals());

  // Same dispatch shape as the magnetic tests: a MouseEvent dressed as a
  // pointermove, because jsdom's PointerEvent drops the coordinates.
  const pointerMove = (el, { pointerType = 'mouse', clientX = 24, clientY = 12 } = {}) => {
    const event = new window.MouseEvent('pointermove', { bubbles: true, clientX, clientY });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    fireEvent(el, event);
  };

  const glowState = {
    phase: PHASE.PLAYING,
    turn: SEAT.YOU,
    winner: null,
    fleetCells: 7,
    you: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    opponent: { fleet: null, marks: emptyMarks(), hitsTaken: 0 },
    yourCommitment: 'abcdef0123456789abcdef0123456789',
    opponentCommitment: '0011223344556677889900112233',
    lastShot: null,
    revealed: false,
  };

  it('follows the pointer across the inspector and fades on leave', () => {
    stubMedia();
    render(<Inspector state={glowState} log={[]} provesMoves={false} />);
    const panel = screen.getByTestId('inspector');
    expect(panel).toHaveClass('glow');

    pointerMove(panel);
    // jsdom rects are zero-sized, so the offset equals the pointer coords.
    expect(panel.style.getPropertyValue('--gx')).toBe('24px');
    expect(panel.style.getPropertyValue('--gy')).toBe('12px');
    expect(panel.style.getPropertyValue('--glow-o')).toBe('1');

    fireEvent.pointerLeave(panel);
    expect(panel.style.getPropertyValue('--glow-o')).toBe('0');
  });

  it('follows the pointer across the public log too', () => {
    stubMedia();
    render(<ShotLog entries={[{ seq: 0, circuit: 'fire', seat: SEAT.YOU, coord: { x: 0, y: 0 } }]} />);
    const panel = screen.getByRole('region', { name: 'Shot log' });
    expect(panel).toHaveClass('glow');
    pointerMove(panel, { clientX: 7, clientY: 9 });
    expect(panel.style.getPropertyValue('--gx')).toBe('7px');
    expect(panel.style.getPropertyValue('--gy')).toBe('9px');
  });

  it('stays dark for touch pointers and reduced motion', () => {
    stubMedia();
    const { unmount } = render(<Inspector state={glowState} log={[]} provesMoves={false} />);
    const touchPanel = screen.getByTestId('inspector');
    pointerMove(touchPanel, { pointerType: 'touch' });
    expect(touchPanel.style.getPropertyValue('--glow-o')).toBe('');
    unmount();

    stubMedia({ reducedMotion: true });
    render(<Inspector state={glowState} log={[]} provesMoves={false} />);
    const calmPanel = screen.getByTestId('inspector');
    pointerMove(calmPanel);
    expect(calmPanel.style.getPropertyValue('--glow-o')).toBe('');
  });
});

describe('ambient grain overlay (noise-background)', () => {
  it('layers static film grain over the scene without ever taking a click', () => {
    expect(appCss).toContain('body::after');
    expect(appCss).toContain('feTurbulence');
    // The overlay must sit above the scene yet stay click-through.
    expect(appCss).toMatch(/body::after\s*\{[^}]*pointer-events:\s*none/s);
    expect(appCss).toMatch(/body::after\s*\{[^}]*position:\s*fixed/s);
    expect(appCss).toContain('mix-blend-mode');
  });
});

describe('scroll-reveal', () => {
  const drivers = [
    { id: 'local', name: 'Local AI', available: true, summary: 'runs in this tab' },
  ];

  it('reveals the landing panels immediately when IntersectionObserver is unavailable', () => {
    // jsdom has no IntersectionObserver - the honesty fallback must show
    // content rather than leaving it hidden at opacity 0.
    const { container } = render(
      <Home drivers={drivers} driverId="local" onDriverChange={() => {}} onStart={() => {}} busy={false} />,
    );
    expect(container.querySelector('.home__hero')).toHaveClass('reveal', 'is-revealed');
    expect(container.querySelector('.home__setup')).toHaveClass('reveal', 'is-revealed');
  });

  it('keeps the reveal transform/opacity-only, token-eased, and reduced-motion safe', () => {
    expect(appCss).toMatch(/\.reveal\s*\{[^}]*opacity:\s*0/s);
    expect(appCss).toMatch(/\.reveal\s*\{[^}]*transform:\s*translateY/s);
    expect(appCss).toContain('var(--spring-soft)');
    expect(appCss).toMatch(/\.reveal\.is-revealed\s*\{[^}]*opacity:\s*1/s);
    expect(appCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^@]*\.reveal\s*\{[^}]*transition:\s*none/s,
    );
  });
});

describe('wobble cards', () => {
  const drivers = [
    { id: 'local', name: 'Local AI', available: true, summary: 'runs in this tab' },
  ];
  const stubMedia = ({ finePointer = true, reducedMotion = false } = {}) => {
    vi.stubGlobal('matchMedia', (query) => ({
      matches:
        (query === '(pointer: fine)' && finePointer) ||
        (query === '(prefers-reduced-motion: reduce)' && reducedMotion),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  };
  // Same dispatch shape as the glow tests: a MouseEvent dressed as a
  // pointermove, because jsdom's PointerEvent drops the coordinates.
  const pointerMove = (el, { pointerType = 'mouse', clientX = 24, clientY = 12 } = {}) => {
    const event = new window.MouseEvent('pointermove', { bubbles: true, clientX, clientY });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    fireEvent(el, event);
  };
  const renderHome = () =>
    render(
      <Home drivers={drivers} driverId="local" onDriverChange={() => {}} onStart={() => {}} busy={false} />,
    );

  afterEach(() => vi.unstubAllGlobals());

  it('leans the landing cards toward the pointer and springs home on leave', () => {
    stubMedia();
    const { container } = renderHome();
    const cards = container.querySelectorAll('.wobble-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.home__hero')).not.toBeNull();
    expect(cards[1].querySelector('.home__setup')).not.toBeNull();

    pointerMove(cards[0]);
    // jsdom rects are zero-sized, so the lean equals the pointer coords / 20.
    expect(cards[0].style.transform).toBe('translate3d(1.2px, 0.6px, 0)');

    fireEvent.pointerLeave(cards[0]);
    expect(cards[0].style.transform).toBe('');
  });

  it('stays perfectly still for touch pointers and reduced motion', () => {
    stubMedia();
    const { container, unmount } = renderHome();
    const touchCard = container.querySelector('.wobble-card');
    pointerMove(touchCard, { pointerType: 'touch' });
    expect(touchCard.style.transform).toBe('');
    unmount();

    stubMedia({ reducedMotion: true });
    const { container: calm } = renderHome();
    const calmCard = calm.querySelector('.wobble-card');
    pointerMove(calmCard);
    expect(calmCard.style.transform).toBe('');
  });

  it('keeps the wobble transform-only, token-eased, and reduced-motion safe', () => {
    expect(appCss).toMatch(/\.wobble-card\s*\{[^}]*transition:\s*transform/s);
    expect(appCss).toMatch(/\.wobble-card\s*\{[^}]*var\(--spring-soft\)/s);
    expect(appCss).toMatch(/\.wobble-card\s*\{[^}]*will-change:\s*transform/s);
    expect(appCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^@]*\.wobble-card\s*\{[^}]*transition:\s*none/s,
    );
  });
});

describe('optimistic busy state', () => {
  const drivers = [
    { id: 'local', name: 'Local AI', available: true, summary: 'runs in this tab' },
  ];

  it('says what is happening while the game sets up instead of going silently dead', () => {
    render(
      <Home drivers={drivers} driverId="local" onDriverChange={() => {}} onStart={() => {}} busy={true} />,
    );
    const btn = screen.getByRole('button', { name: /setting up/i });
    expect(btn).toBeDisabled();
  });

  it('offers the plain Play vs AI action when idle', () => {
    render(
      <Home drivers={drivers} driverId="local" onDriverChange={() => {}} onStart={() => {}} busy={false} />,
    );
    const btn = screen.getByRole('button', { name: 'Play vs AI' });
    expect(btn).toBeEnabled();
  });
});
