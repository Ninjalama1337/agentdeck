import { describe, expect, it } from 'vitest';
import { DESKTOP_SERVICE_UNIT, SERVICE_UNIT_MARKER } from '@agentdeck/shared';
import { parseUnit, quoteExecWord, renderUnit } from '../src/cli/unit.js';

const EXEC = '/home/me/.local/share/agentdeck/runtime/current/bin/agentdeck-server';

describe('service unit', () => {
  it('is named agentdeck.service and starts with the marker', () => {
    expect(DESKTOP_SERVICE_UNIT).toBe('agentdeck.service');
    expect(renderUnit({ execStart: EXEC, lan: false }).split('\n')[0]).toBe(SERVICE_UNIT_MARKER);
    expect(SERVICE_UNIT_MARKER).toBe('# Managed by agentdeck-server');
  });

  it('binds to loopback by default and leaves the port to the config', () => {
    const text = renderUnit({ execStart: EXEC, lan: false });
    expect(text).toContain(`ExecStart=${EXEC}\n`);
    expect(text).toContain('Environment=AGENTDECK_HOST=127.0.0.1\n');
    expect(text).not.toContain('AGENTDECK_PORT');
    expect(text).toContain('Environment=NODE_ENV=production\n');
    expect(text).toContain('Restart=on-failure\n');
    expect(text).toContain('KillMode=process\n');
    // a server that cannot start must not loop forever
    expect(text).toContain('StartLimitBurst=5\n');
    expect(text).toContain('WantedBy=default.target\n');
  });

  it('--lan listens on all interfaces, --port is pinned', () => {
    const text = renderUnit({ execStart: EXEC, lan: true, port: 9100 });
    expect(text).toContain('Environment=AGENTDECK_HOST=0.0.0.0\n');
    expect(text).toContain('Environment=AGENTDECK_PORT=9100\n');
    expect(text).not.toContain('127.0.0.1');
  });

  it('quotes paths with spaces and escapes systemd specifiers', () => {
    expect(quoteExecWord('/plain/path-1.0/bin/x')).toBe('/plain/path-1.0/bin/x');
    expect(quoteExecWord('/home/a b/bin/x')).toBe('"/home/a b/bin/x"');
    expect(quoteExecWord('/home/50%/x$y')).toBe('"/home/50%%/x$$y"');
    expect(quoteExecWord('/home/q"uote/x')).toBe('"/home/q\\"uote/x"');
    const parsed = parseUnit(renderUnit({ execStart: '/home/a b/50%/x', lan: false }));
    expect(parsed.execStart).toBe('/home/a b/50%/x');
  });

  it('reads back what it wrote', () => {
    expect(parseUnit(renderUnit({ execStart: EXEC, lan: false }))).toEqual({
      managed: true,
      lan: false,
      host: '127.0.0.1',
      execStart: EXEC,
    });
    expect(parseUnit(renderUnit({ execStart: EXEC, lan: true, port: 8800 }))).toEqual({
      managed: true,
      lan: true,
      host: '0.0.0.0',
      port: 8800,
      execStart: EXEC,
    });
  });

  it('does not take the unit of a checkout for its own', () => {
    const checkout = `# AgentDeck — systemd user service
[Service]
ExecStart=/usr/bin/env node %h/agentdeck/server/dist/index.js
Environment=AGENTDECK_PORT=8787
Environment=NODE_ENV=production
`;
    expect(parseUnit(checkout)).toMatchObject({ managed: false, lan: false, port: 8787 });
    // The marker only counts as the very first line.
    expect(parseUnit(`[Unit]\n${SERVICE_UNIT_MARKER}\n`).managed).toBe(false);
  });

  it('understands quoted and multi-assignment Environment lines', () => {
    const text = `${SERVICE_UNIT_MARKER}\n[Service]\nEnvironment="AGENTDECK_HOST=0.0.0.0" AGENTDECK_PORT=1234\nExecStart="/a b/x" --flag\n`;
    expect(parseUnit(text)).toMatchObject({ managed: true, lan: true, port: 1234, execStart: '/a b/x' });
  });
});
