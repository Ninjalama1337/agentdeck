/**
 * Firebase Cloud Messaging (HTTP v1) without the firebase-admin dependency:
 * a service-account JWT is exchanged for an OAuth token, which authorizes
 * `messages:send`. Android wakes the APK for these even in Doze, which the
 * WebView's missing Web Push and a dozing WebSocket cannot.
 *
 * The service-account key lives in the data dir (`fcm-service-account.json`,
 * 0600). Without it FCM stays off and Web Push keeps working.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmMessage {
  title: string;
  body: string;
  /** Android channel (must exist in the app) — decides sound and vibration. */
  channelId: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
  high: boolean;
  /**
   * No `notification` block: the app builds the notification itself (needed
   * for action buttons, which the system cannot draw for a closed app).
   */
  dataOnly?: boolean;
  /** FCM data values are strings only. */
  data: Record<string, string>;
}

export type FcmResult = 'ok' | 'dead' | 'error';

type Fetch = typeof fetch;

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export class FcmClient {
  private token: { value: string; expires: number } | undefined;

  private constructor(
    private readonly account: ServiceAccount,
    private readonly fetchFn: Fetch,
  ) {}

  /** Undefined when no (valid) service-account file exists. */
  static async load(file: string, fetchFn: Fetch = fetch): Promise<FcmClient | undefined> {
    try {
      const account = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<ServiceAccount>;
      if (!account.project_id || !account.client_email || !account.private_key) return undefined;
      return new FcmClient(account as ServiceAccount, fetchFn);
    } catch {
      return undefined;
    }
  }

  get projectId(): string {
    return this.account.project_id;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const uri = this.account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.account.client_email,
      scope: SCOPE,
      aud: uri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');
    const res = await this.fetchFn(uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`FCM auth failed: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  async send(deviceToken: string, m: FcmMessage): Promise<FcmResult> {
    try {
      const res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            ...(m.dataOnly ? {} : { notification: { title: m.title, body: m.body } }),
            data: m.dataOnly ? { ...m.data, title: m.title, body: m.body, channel: m.channelId, ...(m.tag ? { tag: m.tag } : {}) } : m.data,
            android: {
              priority: m.high ? 'HIGH' : 'NORMAL',
              ttl: '3600s',
              ...(m.dataOnly ? {} : { notification: { channel_id: m.channelId, ...(m.tag ? { tag: m.tag } : {}) } }),
            },
          },
        }),
      });
      if (res.ok) return 'ok';
      // 404 UNREGISTERED / 400 INVALID_ARGUMENT: the token is gone for good.
      if (res.status === 404 || res.status === 400) return 'dead';
      if (res.status === 401) this.token = undefined;
      return 'error';
    } catch {
      return 'error';
    }
  }
}
