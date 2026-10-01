import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { agentInUse } from '../util/usageAgent';

/** The server caches usage for 30 s, so every poll returns fresh numbers. */
const USAGE_POLL_MS = 60_000;

/**
 * Keeps the top-left usage button current without any tapping:
 * - it follows the agent in use (open chat / visible terminal CLI), and
 * - usage is re-fetched every minute while an agent is in use or a session is
 *   running, as long as the app is visible.
 */
export function useUsageTracking(): void {
  useEffect(() => {
    // Compared against the last *derived* agent, so a manual pick in the usage
    // sheet stays until the user moves to another chat or terminal.
    let derived = agentInUse(useAppStore.getState());
    if (derived) useAppStore.getState().setCurrentUsageAgent(derived);

    const wanted = (): boolean => {
      const st = useAppStore.getState();
      if (!st.token || document.visibilityState !== 'visible') return false;
      return (
        agentInUse(st) !== undefined ||
        Object.values(st.sessionsByProject).some((list) => list.some((s) => s.status === 'running' || s.status === 'queued'))
      );
    };
    let lastFetch = 0;
    const refresh = () => {
      if (!wanted()) return;
      lastFetch = Date.now();
      void useAppStore.getState().refreshUsage({ silent: true });
    };

    const unsub = useAppStore.subscribe((st) => {
      const next = agentInUse(st);
      if (!next || next === derived) return;
      derived = next;
      st.setCurrentUsageAgent(next);
      refresh();
    });
    const timer = window.setInterval(refresh, USAGE_POLL_MS);
    // Timers are throttled in the background: catch up when the app returns.
    const onVisible = () => {
      if (Date.now() - lastFetch >= USAGE_POLL_MS) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsub();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
