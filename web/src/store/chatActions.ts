import { create } from 'zustand';

/** Hand-over from message actions ("Edit") to the composer of the same session. */
interface ChatActions {
  prefill: { sessionId: string; text: string; nonce: number } | null;
  setPrefill(sessionId: string, text: string): void;
  clearPrefill(): void;
}

export const useChatActions = create<ChatActions>((set) => ({
  prefill: null,
  setPrefill: (sessionId, text) => set({ prefill: { sessionId, text, nonce: Date.now() } }),
  clearPrefill: () => set({ prefill: null }),
}));
