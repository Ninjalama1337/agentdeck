import crypto from 'node:crypto';
import type { PairRequestInfo } from '@agentdeck/shared';
import { newId } from '../util/ids.js';

interface PendingPair extends PairRequestInfo {
  /** Secret the requesting device polls with; never shown to anyone else. */
  pollToken: string;
  approved: boolean;
}

export type PairPollResult = 'pending' | 'approved' | 'gone';

/**
 * Pairing requests from outside the LAN, waiting for a paired device to
 * approve them. In memory only: a restart drops them and the new device
 * simply asks again.
 */
export class PairRequests {
  private readonly pending = new Map<string, PendingPair>();

  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly max = 3,
  ) {}

  private sweep(now = Date.now()): void {
    for (const [id, req] of this.pending) {
      if (req.expiresAt <= now) this.pending.delete(id);
    }
  }

  /** True when no further request can be taken until one is decided or expires. */
  isFull(): boolean {
    this.sweep();
    return this.pending.size >= this.max;
  }

  create(deviceName: string, ip: string): { info: PairRequestInfo; pollToken: string } {
    const now = Date.now();
    const req: PendingPair = {
      id: newId('pr'),
      deviceName,
      ip,
      // Shown on both devices so the owner approves the request they started.
      checkCode: crypto.randomInt(0, 10_000).toString().padStart(4, '0'),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      pollToken: crypto.randomBytes(32).toString('hex'),
      approved: false,
    };
    this.pending.set(req.id, req);
    return { info: publicInfo(req), pollToken: req.pollToken };
  }

  /** Requests still waiting for a decision, oldest first. */
  list(): PairRequestInfo[] {
    this.sweep();
    return [...this.pending.values()].filter((r) => !r.approved).map(publicInfo);
  }

  /** Approve or deny; false when the request is gone or already decided. */
  decide(id: string, approve: boolean): boolean {
    this.sweep();
    const req = this.pending.get(id);
    if (!req || req.approved) return false;
    if (approve) req.approved = true;
    else this.pending.delete(id);
    return true;
  }

  /** State for the requesting device; an approved request is handed out once. */
  poll(id: string, pollToken: string): { state: PairPollResult; deviceName?: string } {
    this.sweep();
    const req = this.pending.get(id);
    if (!req || !sameToken(req.pollToken, pollToken)) return { state: 'gone' };
    if (!req.approved) return { state: 'pending' };
    this.pending.delete(id);
    return { state: 'approved', deviceName: req.deviceName };
  }
}

function publicInfo(req: PendingPair): PairRequestInfo {
  const { id, deviceName, ip, checkCode, createdAt, expiresAt } = req;
  return { id, deviceName, ip, checkCode, createdAt, expiresAt };
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
