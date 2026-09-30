/**
 * Per-device preferences (localStorage). Kept apart from the app store so
 * screens can subscribe to a single pref without re-rendering on live state.
 */
import { create } from 'zustand';
import type { DeckNotificationKind } from '@agentdeck/shared';

export type DictationEngine = 'auto' | 'device' | 'server';

export interface Prefs {
  /** Show system notifications (and register Web Push when possible). */
  notifications: boolean;
  notifyKinds: Record<DeckNotificationKind, boolean>;
  /** Short vibration on key taps and events. */
  haptics: boolean;
  termFontSize: number;
  /** Code tab: type into a compose bar (true) or directly into xterm. */
  termCompose: boolean;
  dictation: DictationEngine;
  /** BCP-47 language for dictation, '' = device language. */
  dictationLang: string;
  /** Send chat messages with Enter (desktop) — phones keep Enter = newline. */
  enterToSend: boolean;
}

const KEY = 'agentdeck:prefs';

export const DEFAULT_PREFS: Prefs = {
  notifications: true,
  notifyKinds: {
    'session-done': true,
    'session-error': true,
    'terminal-attention': true,
    'team-done': true,
    'team-error': true,
    info: true,
  },
  haptics: true,
  termFontSize: 12,
  termCompose: true,
  dictation: 'auto',
  dictationLang: '',
  enterToSend: false,
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      notifyKinds: { ...DEFAULT_PREFS.notifyKinds, ...(parsed.notifyKinds ?? {}) },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

interface PrefsStore extends Prefs {
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void;
}

export const usePrefs = create<PrefsStore>()((set, get) => ({
  ...load(),
  set(key, value) {
    set({ [key]: value } as Partial<PrefsStore>);
    const { set: _omit, ...prefs } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable */
    }
  },
}));
