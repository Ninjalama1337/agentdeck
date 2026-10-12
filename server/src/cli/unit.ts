/**
 * The systemd user unit written by `agentdeck-server service install`:
 * rendering, and reading back what an installed one says.
 */
import { DESKTOP_SERVICE_UNIT, SERVICE_UNIT_MARKER } from '@agentdeck/shared';

export { DESKTOP_SERVICE_UNIT, SERVICE_UNIT_MARKER };

export interface UnitSpec {
  /** Absolute path of the launcher: `<runtime>/current/bin/agentdeck-server`. */
  execStart: string;
  /** Bind to all interfaces (phone access in the LAN) instead of loopback. */
  lan: boolean;
  /** Fixed port; unset = whatever config.json / the default says. */
  port?: number;
}

/** One systemd command-line word: quoted (and `%`/`$` escaped) only when it has to be. */
export function quoteExecWord(word: string): string {
  if (/^[A-Za-z0-9_./:+@-]+$/.test(word)) return word;
  return `"${word.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

export function renderUnit(spec: UnitSpec): string {
  const lines = [
    SERVICE_UNIT_MARKER,
    '# Written by `agentdeck-server service install` — changes are overwritten by the next install.',
    '# Logs: journalctl --user -u agentdeck -f',
    '',
    '[Unit]',
    'Description=AgentDeck server (remote control deck for coding agents)',
    'Documentation=https://github.com/Ninjalama1337/agentdeck',
    'After=network-online.target',
    '# A server that cannot start (e.g. the port is taken) gives up after a few tries instead of looping forever.',
    'StartLimitIntervalSec=120',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    'WorkingDirectory=%h',
    `ExecStart=${quoteExecWord(spec.execStart)}`,
    `Environment=AGENTDECK_HOST=${spec.lan ? '0.0.0.0' : '127.0.0.1'}`,
    ...(spec.port !== undefined ? [`Environment=AGENTDECK_PORT=${spec.port}`] : []),
    'Environment=NODE_ENV=production',
    'Restart=on-failure',
    'RestartSec=3',
    '# Only the server itself ends on stop/restart: the terminals run in tmux under',
    '# this service and survive restarts and updates.',
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

export interface ParsedUnit {
  /** First line is SERVICE_UNIT_MARKER: written by us, safe to rewrite. */
  managed: boolean;
  /** Bound to something other than loopback. */
  lan: boolean;
  host?: string;
  port?: number;
  /** The executable of ExecStart (unquoted). */
  execStart?: string;
}

/** Unwraps one level of systemd quoting (`"…"` / `'…'`) around a whole value. */
function unquote(value: string): string {
  const match = /^(["'])(.*)\1$/.exec(value);
  if (!match) return value;
  return (match[2] as string).replace(/\\(.)/g, '$1').replace(/%%/g, '%').replace(/\$\$/g, '$');
}

/** The first word of an ExecStart value (a leading `-`/`@`/`:` modifier is dropped). */
function firstWord(value: string): string | undefined {
  const trimmed = value.trim().replace(/^[-@:+!]+/, '');
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(trimmed);
  if (quoted) return unquote(`"${quoted[1] as string}"`);
  return trimmed.split(/\s+/)[0] || undefined;
}

export function parseUnit(text: string): ParsedUnit {
  const lines = text.split('\n');
  const managed = (lines[0] ?? '').trim() === SERVICE_UNIT_MARKER;
  let host: string | undefined;
  let port: number | undefined;
  let execStart: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('ExecStart=')) {
      execStart = firstWord(line.slice('ExecStart='.length));
    } else if (line.startsWith('Environment=')) {
      // Environment= takes several (optionally quoted) assignments per line.
      for (const token of line.slice('Environment='.length).match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []) {
        const assignment = unquote(token);
        if (assignment.startsWith('AGENTDECK_HOST=')) host = assignment.slice('AGENTDECK_HOST='.length);
        if (assignment.startsWith('AGENTDECK_PORT=')) {
          const n = Number(assignment.slice('AGENTDECK_PORT='.length));
          if (Number.isInteger(n) && n >= 0 && n <= 65535) port = n;
        }
      }
    }
  }
  const loopback = host === undefined || ['127.0.0.1', 'localhost', '::1'].includes(host);
  return {
    managed,
    lan: !loopback,
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(execStart !== undefined ? { execStart } : {}),
  };
}
