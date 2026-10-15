import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { useUnread } from '../store/unread';

/** The chat on screen is read — also each time it changes while you watch it. */
export function useUnreadTracking(): void {
  useEffect(() => {
    const check = (): void => {
      if (document.visibilityState !== 'visible') return;
      const st = useAppStore.getState();
      const id = st.activeSessionId;
      if (st.route.name !== 'chat' || !id) return;
      const session = Object.values(st.sessionsByProject)
        .flat()
        .find((s) => s.id === id);
      useUnread.getState().view(`session:${id}`, Math.max(Date.now(), session?.updatedAt ?? 0));
    };
    check();
    const unsubscribe = useAppStore.subscribe((st, prev) => {
      if (st.route !== prev.route || st.activeSessionId !== prev.activeSessionId || st.sessionsByProject !== prev.sessionsByProject) check();
    });
    document.addEventListener('visibilitychange', check);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
}
