import { useEffect, useRef } from 'react';

/**
 * Scroll container ref that sticks to the bottom while the user is near the
 * bottom (streaming chat). Re-scrolls on every render when stuck.
 */
export function useStickyScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return ref;
}
