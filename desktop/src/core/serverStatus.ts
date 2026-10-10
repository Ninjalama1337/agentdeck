import type { DesktopServerMode, DesktopServerStatus, ServerCliInfo, ServiceCliStatus } from './contract';
import type { HealthProbe } from './health';

export interface ModeInput {
  probe: HealthProbe;
  service: ServiceCliStatus | null;
  /** The running server is the one this app started detached. */
  detachedOurs: boolean;
}

/** How the server runs and whether the app may stop it. */
export function deriveMode(input: ModeInput): { mode: DesktopServerMode; controllable: boolean } {
  if (input.service?.active) return { mode: 'service', controllable: true };
  if (input.probe.state === 'agentdeck') {
    return input.detachedOurs ? { mode: 'detached', controllable: true } : { mode: 'external', controllable: false };
  }
  // Nothing (usable) answers: the app can start one — unless a stranger holds the port.
  return { mode: 'stopped', controllable: input.probe.state === 'closed' };
}

/** Internal view: the contract status plus facts only the shell needs. */
export interface ServerState extends DesktopServerStatus {
  /** The port is held by something that is not AgentDeck (never switch ports — the origin is the profile). */
  portConflict: boolean;
  /** The service unit exists but was not written by `agentdeck-server` (e.g. docs/agentdeck.service). */
  foreignUnit: boolean;
}

export function buildState(info: ServerCliInfo, input: ModeInput): ServerState {
  const { mode, controllable } = deriveMode(input);
  const reachable = input.probe.state === 'agentdeck';
  const version = input.probe.state === 'agentdeck' ? input.probe.version : undefined;
  return {
    mode,
    reachable,
    ...(version ? { version } : {}),
    host: info.host,
    port: info.port,
    controllable,
    service: input.service,
    portConflict: input.probe.state === 'foreign' || input.probe.state === 'unresponsive',
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
