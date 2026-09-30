/**
 * Tiny haptic feedback helper: Capacitor Haptics plugin inside the APK,
 * navigator.vibrate in browsers that support it, silent otherwise.
 */
import { usePrefs } from '../store/prefs';

type Strength = 'light' | 'medium' | 'success' | 'warning';

const PATTERN: Record<Strength, number | number[]> = {
  light: 8,
  medium: 16,
  success: [10, 40, 18],
  warning: [24, 60, 24],
};

export function haptic(strength: Strength = 'light'): void {
  if (!usePrefs.getState().haptics) return;
  const plugin = window.Capacitor?.Plugins?.Haptics;
  if (plugin?.impact) {
    const style = strength === 'light' ? 'LIGHT' : strength === 'medium' ? 'MEDIUM' : 'HEAVY';
    void plugin.impact({ style }).catch(() => undefined);
    return;
  }
  try {
    navigator.vibrate?.(PATTERN[strength]);
  } catch {
    /* unsupported */
  }
}
