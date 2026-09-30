import crypto from 'node:crypto';

/**
 * Signed one-time-ish download tokens for file streaming:
 * `base64url(JSON {projectId, path, exp})` + '.' + base64url(HMAC-SHA256).
 * Android download managers cannot send auth headers, hence query-param auth.
 */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 120;

export interface DownloadTokenPayload {
  projectId: string;
  path: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(secretHex: string, data: string): string {
  return crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(data).digest('base64url');
}

export function signDownloadToken(
  secretHex: string,
  payload: Omit<DownloadTokenPayload, 'exp'> & { exp?: number },
): string {
  const full: DownloadTokenPayload = {
    projectId: payload.projectId,
    path: payload.path,
    exp: payload.exp ?? Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(full));
  return `${body}.${hmac(secretHex, body)}`;
}

/**
 * Verifies signature, expiry and that the token matches the expected
 * project/path pair. Returns the payload or null.
 */
export function verifyDownloadToken(
  secretHex: string,
  token: string,
  expect: { projectId: string; path: string },
): DownloadTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expectedSig = hmac(secretHex, body);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  let payload: DownloadTokenPayload;
  try {
    const json = Buffer.from(body, 'base64url').toString('utf8');
    payload = JSON.parse(json) as DownloadTokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.projectId !== 'string' || typeof payload.path !== 'string') return null;
  if (typeof payload.exp !== 'number') return null;
  if (payload.projectId !== expect.projectId || payload.path !== expect.path) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
