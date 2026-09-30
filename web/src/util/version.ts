/**
 * Tolerant dotted-version comparison for the APK self-update banner
 * ("v1.2.3-beta" vs "1.2" vs "0.0.0-web"). Not a full semver implementation —
 * just enough to answer "is the server's APK newer than the installed one?".
 */

interface ParsedVersion {
  /** Major.minor.patch, missing parts = 0. */
  nums: [number, number, number];
  /** Non-numeric suffix ("-beta", "-debug", "-web"), lowercase; null = release. */
  suffix: string | null;
}

function parseVersion(input: string): ParsedVersion {
  const clean = (input ?? '').trim().replace(/^v/i, '');
  const m = clean.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-._+]([^.\s]*))?/);
  if (!m) return { nums: [0, 0, 0], suffix: clean ? clean.toLowerCase() : null };
  return {
    nums: [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0],
    suffix: m[4] ? m[4].toLowerCase() : null,
  };
}

/**
 * Compare two version strings. Returns < 0 if a < b, > 0 if a > b, 0 if equal.
 * A pre-release suffix ("-beta") sorts LOWER than the plain release.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.suffix !== pb.suffix) {
    if (!pa.suffix) return 1;
    if (!pb.suffix) return -1;
    return pa.suffix < pb.suffix ? -1 : pa.suffix > pb.suffix ? 1 : 0;
  }
  return 0;
}
