/** `v1.2.3` / `1.2.3` / `1.2.3-4-gabc` → [1,2,3]; null when it does not start like a version. */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative / 0 / positive like a comparator; null when either side is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] as number) - (pb[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The bundled server should replace the service's runtime copy: it is newer,
 * differs only in the build suffix, or the two cannot be compared. An older
 * bundle (an old AppImage opened after a newer one) never downgrades the service.
 */
export function runtimeNeedsUpdate(bundled: string, installed: string): boolean {
  if (bundled === installed) return false;
  const cmp = compareVersions(bundled, installed);
  return cmp === null || cmp >= 0;
}
