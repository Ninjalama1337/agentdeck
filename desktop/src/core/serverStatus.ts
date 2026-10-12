import type { DesktopServerMode, DesktopServerStatus, ServerCliInfo, ServiceCliStatus } from './contract';
import type { HealthProbe } from './health';

/** What holds the server's port right now. */
export type ServerHolder =
  /** An AgentDeck server answers. */
  | 'agentdeck'
  /** Another program answers — never ours to talk to, nor to hand the pairing code to. */
  | 'foreign'
  /** Connected, but no answer in time (busy, or still starting). */
  | 'unresponsive'
  /** Nothing listens. */
  | 'none'
  /** Could not be found out (the CLI failed). */
  | 'unknown';

export function holderOf(probe: HealthProbe): ServerHolder {
  switch (probe.state) {
    case 'agentdeck':
      return 'agentdeck';
    case 'foreign':
      return 'foreign';
    case 'unresponsive':
      return 'unresponsive';
    case 'closed':
      return 'none';
  }
}

export interface ModeInput {
  probe: HealthProbe;
  service: ServiceCliStatus | null;
  /** The server this app started detached, when it is the one on the port (marker + pid file + process agree). */
  detached: { host: string } | null;
  /** Bind address the next server the app starts gets: "phone access in the LAN" is on. */
  intendedLan?: boolean;
}

/** How the server runs and whether the app may stop it. */
export function deriveMode(input: ModeInput): { mode: DesktopServerMode; controllable: boolean } {
  if (input.service?.active) return { mode: 'service', controllable: true };
  if (input.probe.state === 'agentdeck') {
    return input.detached ? { mode: 'detached', controllable: true } : { mode: 'external', controllable: false };
  }
  // Ours, but busy or still starting: it is still ours.
  if (input.probe.state === 'unresponsive' && input.detached) return { mode: 'detached', controllable: true };
  // Nothing (usable) answers: the app can start one — unless a stranger holds the port.
  return { mode: 'stopped', controllable: input.probe.state === 'closed' };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Is this bind address reachable from other machines (phone access)? */
export function isLanHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return !(LOOPBACK_HOSTS.has(h) || h.startsWith('127.'));
}

/**
 * The address the server really listens on — not what the config would say: a server the
 * app starts (or its unit) binds loopback unless "phone access" is on.
 */
export function bindHostOf(info: ServerCliInfo, mode: DesktopServerMode, input: ModeInput): string {
  const lan = (on: boolean): string => (on ? '0.0.0.0' : '127.0.0.1');
  const service = input.service;
  if (mode === 'service') return lan(Boolean(service?.lan));
  if (mode === 'detached') return input.detached?.host ?? lan(Boolean(input.intendedLan));
  if (mode === 'external') return info.host;
  // stopped: what the next start would bind
  if (service?.systemd && service.installed && service.managed) return lan(service.lan);
  return lan(Boolean(input.intendedLan));
}

/** Internal view: the contract status plus facts only the shell needs. */
export interface ServerState extends DesktopServerStatus {
  holder: ServerHolder;
  /** The port is held by something that is not (our) AgentDeck — never switch ports, the origin is the profile. */
  portConflict: boolean;
  /** The server accepts connections from other machines. */
  lan: boolean;
  /** The service unit exists but was not written by `agentdeck-server` (e.g. docs/agentdeck.service). */
  foreignUnit: boolean;
}

export function buildState(info: ServerCliInfo, input: ModeInput): ServerState {
  const { mode, controllable } = deriveMode(input);
  const reachable = input.probe.state === 'agentdeck';
  const version = input.probe.state === 'agentdeck' ? input.probe.version : undefined;
  const holder = holderOf(input.probe);
  const host = bindHostOf(info, mode, input);
  return {
    mode,
    reachable,
    ...(version ? { version } : {}),
    host,
    port: info.port,
    controllable,
    service: input.service,
    holder,
    portConflict: holder === 'foreign' || (holder === 'unresponsive' && mode === 'stopped'),
    lan: isLanHost(host),
    foreignUnit: Boolean(input.service?.installed && !input.service.managed),
  };
}

/** The contract shape only (what crosses to the web UI). */
export function toPublicStatus(state: ServerState): DesktopServerStatus {
  return {
    mode: state.mode,
    reachable: state.reachable,
    ...(state.version ? { version: state.version } : {}),
    host: state.host,
    port: state.port,
    controllable: state.controllable,
    service: state.service,
  };
}

export function sameStatus(a: DesktopServerStatus | null, b: DesktopServerStatus | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What the page may ask of the bridge, by who holds the port (see ipc.ts). */
export const trust = {
  /** The pairing code and the bridge go to the AgentDeck server's own pages only. */
  mayHandOut: (holder: ServerHolder): boolean => holder === 'agentdeck',
  /** A call from a page that already has the bridge — refused while a stranger holds the port. */
  mayCall: (holder: ServerHolder): boolean => holder === 'agentdeck' || holder === 'none' || holder === 'unresponsive',
};
