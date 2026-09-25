// The polish kit and the landing screen, tested directly - components
// and state transitions.
//
// The kit's promise is restraint: every effect is pointer-fine and
// motion-allowed only, touch and reduced-motion get a perfectly still page,
// and leaving the surface always restores the resting state. The landing
// screen's promise is honesty: the engine picker shows what is backing the
// game and an unavailable engine says why instead of hiding.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WobbleCard } from '../src/components/WobbleCard.jsx';
import { MagneticButton } from '../src/components/MagneticButton.jsx';
import { useGlow } from '../src/components/Glow.jsx';
import { Hash, Identicon } from '../src/components/Hash.jsx';
import { EmptyState } from '../src/components/EmptyState.jsx';
import { Home } from '../src/components/Home.jsx';

// jsdom has no PointerEvent, and without one fireEvent drops pointerType.
class FakePointerEvent extends MouseEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'mouse';
  }
}
window.PointerEvent = window.PointerEvent ?? FakePointerEvent;

function stubPointer({ fine = true, reducedMotion = false } = {}) {
  vi.stubGlobal('matchMedia', (query) => ({
    matches:
      (query === '(pointer: fine)' && fine) ||
      (query === '(prefers-reduced-motion: reduce)' && reducedMotion),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

beforeEach(() => {
  stubPointer();
});

function GlowProbe() {
  const glow = useGlow();
  return <div data-testid="panel" className="glow" {...glow} />;
}

describe('<WobbleCard>', () => {
  it('leans toward a fine pointer and springs home on leave', () => {
    const { container } = render(<WobbleCard>card</WobbleCard>);
    const card = container.querySelector('.wobble-card');
    card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });

    fireEvent.pointerMove(card, { pointerType: 'mouse', clientX: 190, clientY: 90 });
    expect(card.style.transform).toBe('translate3d(4.5px, 2.0px, 0)');

    fireEvent.pointerLeave(card);
    expect(card.style.transform).toBe('');
  });

  it('stays still for touch pointers and under reduced motion', () => {
    const { container } = render(<WobbleCard>card</WobbleCard>);
    const card = container.querySelector('.wobble-card');
    card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });

    fireEvent.pointerMove(card, { pointerType: 'touch', clientX: 190, clientY: 90 });
    expect(card.style.transform).toBe('');

    stubPointer({ fine: true, reducedMotion: true });
    fireEvent.pointerMove(card, { pointerType: 'mouse', clientX: 190, clientY: 90 });
    expect(card.style.transform).toBe('');
  });
});

describe('<MagneticButton>', () => {
  it('pulls a few px toward the pointer, capped, and resets on leave', () => {
    render(<MagneticButton>go</MagneticButton>);
    const btn = screen.getByRole('button', { name: 'go' });
    btn.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40 });

    // Far past the cap: dx = 490 * 0.18 = 88.2 -> capped at 6
    fireEvent.pointerMove(btn, { pointerType: 'mouse', clientX: 540, clientY: -500 });
    expect(btn.style.getPropertyValue('--mx')).toBe('6.0px');
    expect(btn.style.getPropertyValue('--my')).toBe('-6.0px');

    fireEvent.pointerLeave(btn);
    expect(btn.style.getPropertyValue('--mx')).toBe('0px');
    expect(btn.style.getPropertyValue('--my')).toBe('0px');
  });

  it('stays inert for touch and still works as a plain button', async () => {
    const onClick = vi.fn();
    render(<MagneticButton onClick={onClick}>go</MagneticButton>);
    const btn = screen.getByRole('button', { name: 'go' });

    fireEvent.pointerMove(btn, { pointerType: 'touch', clientX: 500, clientY: 500 });
    expect(btn.style.getPropertyValue('--mx')).toBe('');

    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('useGlow', () => {
  it('moves the light with a fine pointer and fades it on leave', () => {
    render(<GlowProbe />);
    const panel = screen.getByTestId('panel');
    panel.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 100 });

    fireEvent.pointerMove(panel, { pointerType: 'mouse', clientX: 60, clientY: 70 });
    expect(panel.style.getPropertyValue('--gx')).toBe('50px');
    expect(panel.style.getPropertyValue('--gy')).toBe('50px');
    expect(panel.style.getPropertyValue('--glow-o')).toBe('1');

    fireEvent.pointerLeave(panel);
    expect(panel.style.getPropertyValue('--glow-o')).toBe('0');
  });

  it('ignores touch pointers entirely', () => {
    render(<GlowProbe />);
    const panel = screen.getByTestId('panel');
    fireEvent.pointerMove(panel, { pointerType: 'touch', clientX: 60, clientY: 70 });
    expect(panel.style.getPropertyValue('--gx')).toBe('');
    expect(panel.style.getPropertyValue('--glow-o')).toBe('');
  });
});

describe('<Hash> and <Identicon>', () => {
  it('truncates a commitment in mono and keeps the full value on hover', () => {
    const value = 'abcdef0123456789'.repeat(4);
    const { container } = render(<Hash value={value} />);
    const el = container.querySelector('.mono');
    expect(el).toHaveTextContent('abcdef01…456789');
    expect(el).toHaveAttribute('title', value);
  });

  it('says not committed when there is nothing to show', () => {
    render(<Hash value={null} />);
    expect(screen.getByText('not committed')).toBeInTheDocument();
  });

  it('renders no fingerprint tile without a value', () => {
    const { container } = render(<Identicon value={null} label="their" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('<EmptyState> ', () => {
  it('renders a decorative glyph, a title, and an optional hint', () => {
    const { container, rerender } = render(<EmptyState title="No shots yet" hint="Fire to begin" />);
    expect(container.querySelector('.empty-state__glyph').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('No shots yet')).toBeInTheDocument();
    expect(screen.getByText('Fire to begin')).toBeInTheDocument();

    rerender(<EmptyState title="No shots yet" />);
    expect(screen.queryByText('Fire to begin')).not.toBeInTheDocument();
    expect(screen.getByText('No shots yet')).toBeInTheDocument();
  });
});

describe('<Home> landing screen', () => {
  const drivers = [
    { id: 'local', name: 'Local session', summary: 'in-browser driver', available: true },
    { id: 'midnight', name: 'Midnight preprod', summary: '', available: false, reason: 'not wired up yet' },
  ];

  function renderHome(props = {}) {
    return render(
      <Home
        drivers={drivers}
        driverId="local"
        onDriverChange={props.onDriverChange ?? (() => {})}
        onStart={props.onStart ?? (() => {})}
        busy={props.busy ?? false}
      />,
    );
  }

  it('shows every engine, and an unavailable one states its reason instead of hiding', () => {
    renderHome();
    const midnight = screen.getByRole('button', { name: /midnight preprod/i });
    expect(midnight).toBeDisabled();
    expect(midnight).toHaveTextContent(/not wired up yet/i);
    expect(screen.getByRole('button', { name: /local session/i })).toBeEnabled();
  });

  it('lets you pick difficulty and seed, then starts with exactly those', async () => {
    const onStart = vi.fn();
    renderHome({ onStart });

    await userEvent.click(screen.getByRole('button', { name: 'hard' }));
    expect(screen.getByRole('button', { name: 'hard' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'medium' })).toHaveAttribute('aria-pressed', 'false');

    const seed = screen.getByLabelText(/game seed/i);
    await userEvent.clear(seed);
    await userEvent.type(seed, '42');

    await userEvent.click(screen.getByRole('button', { name: /play vs ai/i }));
    expect(onStart).toHaveBeenCalledWith({ seed: 42, difficulty: 'hard' });
  });

  it('switches engines through the picker', async () => {
    const onDriverChange = vi.fn();
    renderHome({ onDriverChange });
    await userEvent.click(screen.getByRole('button', { name: /local session/i }));
    expect(onDriverChange).toHaveBeenCalledWith('local');
  });

  it('locks the start button and says so while a game is being set up', () => {
    renderHome({ busy: true });
    const start = screen.getByRole('button', { name: /setting up/i });
    expect(start).toBeDisabled();
  });
});
