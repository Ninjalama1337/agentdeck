#!/usr/bin/env node
/**
 * agentdeck-server — the server and its command line.
 *
 *   agentdeck-server                     run the server (like `node dist/index.js`)
 *   agentdeck-server info --json         where it lives (data dir, port, pairing code file …)
 *   agentdeck-server service <action>    run it as a systemd user service
 *
 * Kept light on purpose: only starting the server loads the server itself, so
 * `info` and `service` answer fast and print nothing but their result.
 */
import os from 'node:os';
import { BUNDLE_ROOT, VERSION } from './version.js';
import { CliError, systemExec } from './cli/exec.js';
import { parseArgs, USAGE } from './cli/args.js';
import { collectInfo } from './cli/info.js';
import {
  serviceControl,
  serviceInstall,
  serviceStatus,
  serviceUninstall,
  servicePaths,
  type ServiceContext,
} from './cli/service.js';

const out = (text: string): void => void process.stdout.write(`${text}\n`);
const err = (text: string): void => void process.stderr.write(`${text}\n`);

function printStatus(status: Awaited<ReturnType<typeof serviceStatus>>): void {
  out(
    [
      `systemd:   ${status.systemd ? 'available' : 'not available'}`,
      `installed: ${status.installed ? `yes${status.managed ? '' : ' (not managed by agentdeck-server)'}` : 'no'}`,
      `enabled:   ${status.enabled ? 'yes' : 'no'}`,
      `running:   ${status.active ? `yes${status.mainPid ? ` (pid ${status.mainPid})` : ''}` : 'no'}`,
      `network:   ${status.lan ? 'all interfaces (LAN)' : 'this computer only'}`,
      ...(status.runtimeVersion ? [`version:   ${status.runtimeVersion}`] : []),
      `unit:      ${status.unitPath}`,
    ].join('\n'),
  );
}

/** The data dir for the stray-server check; a broken config just skips the check. */
function dataDirOf(): { dataDir?: string } {
  try {
    return { dataDir: collectInfo({ unitPath: servicePaths().unitPath }).dataDir };
  } catch {
    return {};
  }
}

async function run(argv: string[]): Promise<void> {
  const cmd = parseArgs(argv);
  switch (cmd.kind) {
    case 'serve': {
      const { serve } = await import('./serve.js');
      await serve();
      return;
    }
    case 'help':
      out(USAGE);
      return;
    case 'version':
      out(VERSION);
      return;
    case 'info': {
      const info = collectInfo({ unitPath: servicePaths().unitPath });
      if (cmd.json) {
        out(JSON.stringify(info));
      } else {
        out(Object.entries(info).map(([k, v]) => `${k.padEnd(16)} ${String(v)}`).join('\n'));
      }
      return;
    }
    case 'service': {
      // Progress goes to stderr under --json so stdout stays one JSON document.
      const ctx: ServiceContext = {
        exec: systemExec,
        paths: servicePaths(process.env, os.homedir()),
        bundleRoot: BUNDLE_ROOT,
        report: cmd.json ? err : out,
        ...dataDirOf(),
      };
      let status;
      switch (cmd.action) {
        case 'status':
          status = await serviceStatus(ctx);
          break;
        case 'install':
          status = await serviceInstall(ctx, {
            lan: cmd.lan,
            ...(cmd.port !== undefined ? { port: cmd.port } : {}),
            start: cmd.start,
            force: cmd.force,
          });
          break;
        case 'uninstall':
          status = await serviceUninstall(ctx, { force: cmd.force, ...(BUNDLE_ROOT ? { runningFrom: BUNDLE_ROOT } : {}) });
          break;
        default:
          status = await serviceControl(ctx, cmd.action);
      }
      if (cmd.json) out(JSON.stringify(status));
      else if (cmd.action === 'status') printStatus(status);
      return;
    }
  }
}

run(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const wantsJson = process.argv.includes('--json');
  err(message);
  // A --json caller always gets a JSON document on stdout, failure or not.
  if (wantsJson) out(JSON.stringify({ error: message }));
  process.exit(error instanceof CliError ? error.exitCode : 1);
});
