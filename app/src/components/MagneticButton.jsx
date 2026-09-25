import { useCallback, useRef } from 'react';

/**
 * Magnetic primary button (docs/18 section 1: "magnetic buttons" micro-feedback).
 *
 * The surface leans a few px toward the pointer and springs back on leave.
 * Fine pointers with motion allowed only; the movement rides on the shared
 * --mx/--my/--lift/--press transform vars on .btn, so hover lift and press
 * compression keep working untouched.
 */
const PULL = 0.18;
const CAP_PX = 6;

function motionAllowed() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return (
    window.matchMedia('(pointer: fine)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function MagneticButton({ className = '', children, ...props }) {
  const ref = useRef(null);

  const onPointerMove = useCallback((event) => {
    const el = ref.current;
    if (!el || event.pointerType === 'touch' || !motionAllowed()) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const rect = el.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const mx = Math.max(-CAP_PX, Math.min(CAP_PX, dx * PULL));
    const my = Math.max(-CAP_PX, Math.min(CAP_PX, dy * PULL));
    el.style.setProperty('--mx', `${mx.toFixed(1)}px`);
    el.style.setProperty('--my', `${my.toFixed(1)}px`);
  }, []);

  const onPointerLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--mx', '0px');
    el.style.setProperty('--my', '0px');
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      className={`${className} btn--magnetic`.trim()}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      {...props}
    >
      {children}
    </button>
  );
}
