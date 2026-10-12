import { describe, expect, it } from 'vitest';
import type { ServerCliInfo, ServiceCliStatus } from '../src/core/contract';
import type { HealthProbe } from '../src/core/health';
import { bindHostOf, buildState, deriveMode, holderOf, isLanHost, sameStatus, toPublicStatus, trust } from '../src/core/serverStatus';

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
    expect(deriveMode({ probe: up, service: unit({ active: true }), detached: null })).toEqual({ mode: 'service', controllable: true });
    expect(deriveMode({ probe: { state: 'closed' }, service: unit({ active: true }), detached: null })).toEqual({ mode: 'service', controllable: true });
  });

  it('a server we started is detached and controllable', () => {
    expect(deriveMode({ probe: up, service: null, detached: { host: '127.0.0.1' } })).toEqual({ mode: 'detached', controllable: true });
  });

  it('any other answering server is external and not ours to stop', () => {
    expect(deriveMode({ probe: up, service: null, detached: null })).toEqual({ mode: 'external', controllable: false });
    expect(deriveMode({ probe: up, service: unit(), detached: null })).toEqual({ mode: 'external', controllable: false });
  });

  it('nothing listening is stopped and startable; a foreign port holder is not', () => {
    expect(deriveMode({ probe: { state: 'closed' }, service: unit(), detached: null })).toEqual({ mode: 'stopped', controllable: true });
    expect(deriveMode({ probe: { state: 'foreign' }, service: null, detached: null })).toEqual({ mode: 'stopped', controllable: false });
    expect(deriveMode({ probe: { state: 'unresponsive' }, service: null, detached: null })).toEqual({ mode: 'stopped', controllable: false });
  });
});

describe('bind address (what the status reports as host)', () => {
  const info = { ...INFO, host: '0.0.0.0' }; // the config's own default
  const build = (patch: Partial<Parameters<typeof buildState>[1]>) =>
    buildState(info, { probe: up, service: null, detached: null, ...patch });

  it('a unit binds by its --lan, not by the config', () => {
    expect(build({ service: unit({ active: true, lan: false }) }).host).toBe('127.0.0.1');
    expect(build({ service: unit({ active: true, lan: true }) }).host).toBe('0.0.0.0');
  });

  it('a server the app started binds as it was started', () => {
    expect(build({ detached: { host: '127.0.0.1' } }).host).toBe('127.0.0.1');
    expect(build({ detached: { host: '0.0.0.0' } }).host).toBe('0.0.0.0');
  });

  it('an external server reports what its config says', () => {
    expect(build({}).host).toBe('0.0.0.0');
    expect(build({}).lan).toBe(true);
  });

  it('a stopped server reports what the next start would bind', () => {
    expect(build({ probe: { state: 'closed' }, intendedLan: false }).host).toBe('127.0.0.1');
    expect(build({ probe: { state: 'closed' }, intendedLan: true }).host).toBe('0.0.0.0');
    expect(build({ probe: { state: 'closed' }, service: unit({ lan: true }), intendedLan: false }).host).toBe('0.0.0.0');
  });

  it('knows which addresses are reachable from other machines', () => {
    expect(isLanHost('0.0.0.0')).toBe(true);
    expect(isLanHost('192.168.1.5')).toBe(true);
    expect(isLanHost('127.0.0.1')).toBe(false);
    expect(isLanHost('::1')).toBe(false);
    expect(isLanHost('localhost')).toBe(false);
    expect(bindHostOf(info, 'external', { probe: up, service: null, detached: null })).toBe('0.0.0.0');
  });
});

describe('who holds the port', () => {
  it('maps the probe', () => {
    expect(holderOf({ state: 'agentdeck' })).toBe('agentdeck');
    expect(holderOf({ state: 'foreign' })).toBe('foreign');
    expect(holderOf({ state: 'unresponsive' })).toBe('unresponsive');
    expect(holderOf({ state: 'closed' })).toBe('none');
  });

  it('hands the pairing code and the bridge to AgentDeck only', () => {
    expect(trust.mayHandOut('agentdeck')).toBe(true);
    for (const holder of ['foreign', 'unresponsive', 'none', 'unknown'] as const) expect(trust.mayHandOut(holder)).toBe(false);
  });

  it('refuses calls from the bridge while a stranger (or an unknown) holds the port', () => {
    expect(trust.mayCall('agentdeck')).toBe(true);
    expect(trust.mayCall('none')).toBe(true); // stopped: the page must still be able to start it
    expect(trust.mayCall('unresponsive')).toBe(true);
    expect(trust.mayCall('foreign')).toBe(false);
    expect(trust.mayCall('unknown')).toBe(false);
  });

  it('a busy server of ours is still ours, a busy stranger is a conflict', () => {
    expect(deriveMode({ probe: { state: 'unresponsive' }, service: null, detached: { host: '127.0.0.1' } })).toEqual({ mode: 'detached', controllable: true });
    const stranger = buildState(INFO, { probe: { state: 'unresponsive' }, service: null, detached: null });
    expect(stranger).toMatchObject({ mode: 'stopped', controllable: false, portConflict: true, holder: 'unresponsive' });
    const ours = buildState(INFO, { probe: { state: 'unresponsive' }, service: null, detached: { host: '127.0.0.1' } });
    expect(ours).toMatchObject({ mode: 'detached', portConflict: false, reachable: false });
  });
});

describe('buildState', () => {
  it('carries version, address and the shell-only facts', () => {
    const state = buildState(INFO, { probe: up, service: unit({ active: true }), detached: null });
    expect(state).toMatchObject({ mode: 'service', reachable: true, version: '1.2.3', host: '127.0.0.1', port: 4317, portConflict: false, foreignUnit: false });
    expect(buildState(INFO, { probe: { state: 'foreign' }, service: null, detached: null }).portConflict).toBe(true);
    expect(buildState(INFO, { probe: { state: 'foreign' }, service: null, detached: null }).holder).toBe('foreign');
    expect(buildState(INFO, { probe: { state: 'closed' }, service: unit({ managed: false }), detached: null }).foreignUnit).toBe(true);
  });

  it('toPublicStatus keeps only the contract fields', () => {
    const state = buildState(INFO, { probe: up, service: null, detached: null });
    const pub = toPublicStatus(state);
    expect(pub).not.toHaveProperty('holder');
    expect(Object.keys(pub).sort()).toEqual(['controllable', 'host', 'mode', 'port', 'reachable', 'service', 'version']);
    expect(sameStatus(pub, toPublicStatus(state))).toBe(true);
    expect(sameStatus(pub, null)).toBe(false);
  });
});
