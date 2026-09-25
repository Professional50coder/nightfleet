import { useCallback, useRef } from 'react';

/**
 * Pointer-tracked glow. A soft
 * proof-colored light follows the pointer across a panel and fades out on
 * leave. Fine pointers with motion allowed only; the glow layer is
 * opacity-only and pointer-events:none, so layout and clicks never change.
 */
function motionAllowed() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return (
    window.matchMedia('(pointer: fine)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Returns { ref, onPointerMove, onPointerLeave } to spread onto a panel that
 * also carries the `glow` class. The handlers only move CSS vars; the
 * stylesheet owns how the light looks.
 */
export function useGlow() {
  const ref = useRef(null);

  const onPointerMove = useCallback((event) => {
    const el = ref.current;
    if (!el || event.pointerType === 'touch' || !motionAllowed()) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--gx', `${Math.round(event.clientX - rect.left)}px`);
    el.style.setProperty('--gy', `${Math.round(event.clientY - rect.top)}px`);
    el.style.setProperty('--glow-o', '1');
  }, []);

  const onPointerLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--glow-o', '0');
  }, []);

  return { ref, onPointerMove, onPointerLeave };
}
