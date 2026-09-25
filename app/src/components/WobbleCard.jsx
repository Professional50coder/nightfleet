import { useCallback, useRef } from 'react';

/**
 * Wobble card (restyled with perfekt
 * tokens and stripped of next/* for Vite). The card leans a few pixels
 * toward the pointer while hovered and springs home on leave. Transform is
 * the only property that ever moves, so layout, reveal entrances, and clicks
 * are untouched. Fine pointers with motion allowed only - touch pointers and
 * reduced-motion users get a perfectly still card.
 */
function motionAllowed() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return (
    window.matchMedia('(pointer: fine)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function WobbleCard({ children, className = '' }) {
  const ref = useRef(null);

  const onPointerMove = useCallback((event) => {
    const el = ref.current;
    if (!el || event.pointerType === 'touch' || !motionAllowed()) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const rect = el.getBoundingClientRect();
    const x = (event.clientX - (rect.left + rect.width / 2)) / 20;
    const y = (event.clientY - (rect.top + rect.height / 2)) / 20;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }, []);

  const onPointerLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = '';
  }, []);

  return (
    <div
      ref={ref}
      className={`wobble-card ${className}`.trim()}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>
  );
}
