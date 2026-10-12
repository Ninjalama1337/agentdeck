/** Command line of `agentdeck-server` → a command (pure, so the tests can feed it argv). */
import { CliError } from './exec.js';

export type CliCommand =
  | { kind: 'serve' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'info'; json: boolean }
  | { kind: 'service'; action: 'status' | 'start' | 'stop' | 'restart'; json: boolean }
  | { kind: 'service'; action: 'install'; json: boolean; lan: boolean; port?: number; start: boolean; force: boolean }
  | { kind: 'service'; action: 'uninstall'; json: boolean; force: boolean };

export const USAGE = `agentdeck-server — AgentDeck server

Usage:
  agentdeck-server                       run the server in the foreground
  agentdeck-server info [--json]         data dir, address, pairing code file, version
  agentdeck-server service status [--json]
  agentdeck-server service install [--lan] [--port N] [--no-start] [--force]
                                         keep the server running as a systemd user service
  agentdeck-server service uninstall [--force]
                                         stop and remove the service (your data stays)
  agentdeck-server service start|stop|restart
  agentdeck-server --version

Options:
  --json       machine-readable output (the only thing on stdout)
  --lan        listen on all interfaces (phone access in the LAN), default: loopback only
  --port N     fixed port for the service (default: config.json / 8787)
  --no-start   enable the service for the next login, do not start it now
  --force      also replace/remove a unit that agentdeck-server did not write
`;

const usageError = (message: string): CliError => new CliError(`${message}\n\n${USAGE}`, 2);

interface Flags {
  json: boolean;
  lan: boolean;
  port?: number;
  start: boolean;
  force: boolean;
}

function parseFlags(args: string[], allowed: ReadonlyArray<keyof Flags>): Flags {
  const flags: Flags = { json: false, lan: false, start: true, force: false };
  const allow = (name: keyof Flags, flag: string): void => {
    if (!allowed.includes(name)) throw usageError(`Unknown option for this command: ${flag}`);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') {
      allow('json', arg);
      flags.json = true;
    } else if (arg === '--lan') {
      allow('lan', arg);
      flags.lan = true;
    } else if (arg === '--no-start') {
      allow('start', arg);
      flags.start = false;
    } else if (arg === '--force') {
      allow('force', arg);
      flags.force = true;
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      allow('port', arg);
      const raw = arg === '--port' ? args[++i] : arg.slice('--port='.length);
      const port = Number(raw);
      if (raw === undefined || raw === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw usageError(`--port needs a port number between 1 and 65535 (got ${raw ?? 'nothing'}).`);
      }
      flags.port = port;
    } else {
      throw usageError(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

export function parseArgs(argv: string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: 'serve' };
  if (first === '-h' || first === '--help' || first === 'help') return { kind: 'help' };
  if (first === '-v' || first === '--version' || first === 'version') return { kind: 'version' };
  if (first === 'info') {
    return { kind: 'info', json: parseFlags(rest, ['json']).json };
  }
  if (first === 'service') {
    const [action, ...flagArgs] = rest;
    switch (action) {
      case 'status':
      case 'start':
      case 'stop':
      case 'restart':
        return { kind: 'service', action, json: parseFlags(flagArgs, ['json']).json };
      case 'install': {
        const f = parseFlags(flagArgs, ['json', 'lan', 'port', 'start', 'force']);
        return {
          kind: 'service',
          action,
          json: f.json,
          lan: f.lan,
          ...(f.port !== undefined ? { port: f.port } : {}),
          start: f.start,
          force: f.force,
        };
      }
      case 'uninstall': {
        const f = parseFlags(flagArgs, ['json', 'force']);
        return { kind: 'service', action, json: f.json, force: f.force };
      }
      default:
        throw usageError(action === undefined ? 'service needs an action.' : `Unknown service action: ${action}`);
    }
  }
  throw usageError(`Unknown command: ${first}`);
}
