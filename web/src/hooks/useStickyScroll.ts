import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Chat scrolling: the list follows new content while the user is at the
 * bottom and stays put once they scroll up to read.
 *
 * `ref` goes on the scroll container, `contentRef` on its content. Growth is
 * watched on the elements themselves (streamed text, a keyboard opening), so
 * it works no matter which component re-rendered.
 */
export function useStickyScroll<T extends HTMLElement, C extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const contentRef = useRef<C | null>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  /** Content arrived below while the user was reading further up. */
  const [unseen, setUnseen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      stick.current = near;
      setAtBottom(near);
      if (near) setUnseen(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver === 'undefined') return () => el.removeEventListener('scroll', onScroll);

    let contentHeight = contentRef.current?.offsetHeight ?? 0;
    const observer = new ResizeObserver(() => {
      const height = contentRef.current?.offsetHeight ?? 0;
      const grew = height > contentHeight;
      contentHeight = height;
      if (stick.current) el.scrollTop = el.scrollHeight;
      else if (grew) setUnseen(true);
    });
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, []);

  // Before the paint, so a chat opens at its end instead of jumping there.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    setUnseen(false);
    el.scrollTop = el.scrollHeight;
  }, []);

  return { ref, contentRef, atBottom, unseen, scrollToBottom };
}
