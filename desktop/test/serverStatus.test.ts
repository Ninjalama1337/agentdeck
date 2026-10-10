import { describe, expect, it } from 'vitest';
import type { ServerCliInfo, ServiceCliStatus } from '../src/core/contract';
import type { HealthProbe } from '../src/core/health';
import { buildState, deriveMode, sameStatus, toPublicStatus } from '../src/core/serverStatus';

const up: HealthProbe = { state: 'agentdeck', version: '1.2.3' };
const unit = (patch: Partial<ServiceCliStatus> = {}): ServiceCliStatus => ({
  systemd: true,
  installed: true,
  managed: true,
  enabled: true,
  active: false,
  unitPath: '/u',
  lan: false,
  ...patch,
});
const INFO: ServerCliInfo = { version: '1.2.3', packaged: true, dataDir: '/d', configPath: '', host: '127.0.0.1', port: 4317, pairingCodeFile: '/d/c', pidFile: '/d/p' };

describe('deriveMode', () => {
  it('an active unit means service mode, reachable or not', () => {
    expect(deriveMode({ probe: up, service: unit({ active: true }), detachedOurs: false })).toEqual({ mode: 'service', controllable: true });
    expect(deriveMode({ probe: { state: 'closed' }, service: unit({ active: true }), detachedOurs: false })).toEqual({ mode: 'service', controllable: true });
  });

  it('a server we started is detached and controllable', () => {
    expect(deriveMode({ probe: up, service: null, detachedOurs: true })).toEqual({ mode: 'detached', controllable: true });
  });

  it('any other answering server is external and not ours to stop', () => {
    expect(deriveMode({ probe: up, service: null, detachedOurs: false })).toEqual({ mode: 'external', controllable: false });
    expect(deriveMode({ probe: up, service: unit(), detachedOurs: false })).toEqual({ mode: 'external', controllable: false });
  });

  it('nothing listening is stopped and startable; a foreign port holder is not', () => {
    expect(deriveMode({ probe: { state: 'closed' }, service: unit(), detachedOurs: false })).toEqual({ mode: 'stopped', controllable: true });
    expect(deriveMode({ probe: { state: 'foreign' }, service: null, detachedOurs: false })).toEqual({ mode: 'stopped', controllable: false });
    expect(deriveMode({ probe: { state: 'unresponsive' }, service: null, detachedOurs: false })).toEqual({ mode: 'stopped', controllable: false });
  });
});

describe('buildState', () => {
  it('carries version, address and the shell-only facts', () => {
    const state = buildState(INFO, { probe: up, service: unit({ active: true }), detachedOurs: false });
    expect(state).toMatchObject({ mode: 'service', reachable: true, version: '1.2.3', host: '127.0.0.1', port: 4317, portConflict: false, foreignUnit: false });
    expect(buildState(INFO, { probe: { state: 'foreign' }, service: null, detachedOurs: false }).portConflict).toBe(true);
    expect(buildState(INFO, { probe: { state: 'closed' }, service: unit({ managed: false }), detachedOurs: false }).foreignUnit).toBe(true);
  });

  it('toPublicStatus keeps only the contract fields', () => {
    const state = buildState(INFO, { probe: up, service: null, detachedOurs: false });
    const pub = toPublicStatus(state);
    expect(Object.keys(pub).sort()).toEqual(['controllable', 'host', 'mode', 'port', 'reachable', 'service', 'version']);
    expect(sameStatus(pub, toPublicStatus(state))).toBe(true);
    expect(sameStatus(pub, null)).toBe(false);
  });
});
