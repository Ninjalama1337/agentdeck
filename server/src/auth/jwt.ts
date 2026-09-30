import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'agentdeck';
const AUDIENCE = 'agentdeck-device';
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface DeviceTokenPayload {
  deviceId: string;
  name: string;
}

function key(secretHex: string): Uint8Array {
  return new TextEncoder().encode(secretHex);
}

export async function signDeviceToken(secretHex: string, payload: DeviceTokenPayload): Promise<string> {
  return new SignJWT({ deviceId: payload.deviceId, name: payload.name })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(key(secretHex));
}

/** Verifies a device token; returns null on any failure (expired, tampered, wrong key). */
export async function verifyDeviceToken(
  secretHex: string,
  token: string,
): Promise<DeviceTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key(secretHex), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    const deviceId = payload['deviceId'];
    const name = payload['name'];
    if (typeof deviceId !== 'string' || typeof name !== 'string') return null;
    return { deviceId, name };
  } catch {
    return null;
  }
}
