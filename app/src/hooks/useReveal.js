import { useEffect, useRef } from 'react';

/**
 * Scroll-reveal. Attach the returned
 * ref to an element that also carries the `reveal` class; it gains
 * `is-revealed` the first time it scrolls into view, then is left alone.
 *
 * Honesty rule: content is never trapped behind the effect. When
 * IntersectionObserver is missing, or the user prefers reduced motion, the
 * element is revealed immediately so nothing ever stays hidden.
 */
export function useReveal() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof IntersectionObserver !== 'function' || reduced) {
      el.classList.add('is-revealed');
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-revealed');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return ref;
}
