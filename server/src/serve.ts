/**
 * AgentDeck server: config → app → listen → banner → shutdown. Started by
 * `index.ts` (checkout, `npm start`) and by the `agentdeck-server` CLI.
 */
import { markClaudeOnboarded } from './admin/claudeOnboarding.js';
import { lanAddresses } from './util/net.js';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { findWebDist } from './http/webDist.js';
import { augmentedPath, listPresets } from './term/presets.js';
import { withLaunchModels } from './term/launchModels.js';
import { removePidFile, writePidFile } from './util/pidfile.js';
import { NAME, VERSION } from './version.js';

async function main(): Promise<void> {
  // systemd and other minimal environments start us without ~/.local/bin, nvm
  // etc. on PATH; agent detection and headless runs need the same lookup dirs
  // the terminals already get.
  process.env.PATH = augmentedPath(process.env.PATH);
  const config = loadConfig();
  const { app, io, deps, manager, agents, tunnel, logger } = await buildApp(config);

  // Listen immediately; agent detection is capped at 5s per adapter and may
  // still be running (it broadcasts agent:update when done).
  void agents.detectAll().catch((err) => logger.error({ err }, 'agent detection crashed'));

  // A Claude sign-in stored before this server marked the setup complete
  // would still make every new `claude` terminal ask to sign in again.
  try {
    if (markClaudeOnboarded()) logger.info('marked Claude Code first-start setup as complete');
  } catch (err) {
    logger.warn({ err }, 'could not mark Claude Code setup as complete');
  }

  await app.listen({ port: config.port, host: config.host });

  // Resume live file watching for every registered project (after listen, so
  // the HTTP surface is up when the first change events arrive).
  for (const project of deps.store.listProjects()) {
    deps.fileWatchers.ensureStarted(project.id, project.path);
  }

  // Recurring agent runs ("agents on routines") — pure timers, no I/O at boot.
  deps.routines.start();

  // `agy models` asks the network — have the launcher's model lists ready before it first opens.
  void withLaunchModels(listPresets()).catch(() => undefined);

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const lanIps = lanAddresses();
  const primaryUrl = `http://localhost:${port}`;

  // Lazy tunnel start: the server is already listening — cloudflared connects
  // in the background and every failure stays contained in the manager.
  tunnel.start(port);

  const lines: string[] = [];
  const rule = '─'.repeat(64);
  lines.push('');
  lines.push(rule);
  lines.push(`  🃏 ${NAME} v${VERSION} — remote control deck for coding agents`);
  lines.push(rule);
  lines.push(`  Local:    ${primaryUrl}`);
  for (const ip of lanIps) {
    lines.push(`  Network:  http://${ip}:${port}`);
  }
  lines.push('');
  lines.push(`  Pairing code: ${deps.pairingCode}   (scan to pair, or type it in)`);
  await new Promise<void>((resolve) => {
    import('qrcode-terminal').then((qrcode) => {
      qrcode.default.generate(primaryUrl, { small: true }, (qr: string) => {
        for (const qrLine of qr.split('\n')) lines.push(`  ${qrLine}`);
        resolve();
      });
    }).catch(() => resolve());
  });
  lines.push('');
  lines.push('  MCP bridge (register as MCP server in any IDE agent):');
  lines.push(`    AGENTDECK_URL=http://127.0.0.1:${port} \\`);
  lines.push(`    AGENTDECK_BRIDGE_TOKEN=$(<${config.dataDir}/bridge-token>) agentdeck-mcp`);
  lines.push(`  Bridge token: ${deps.bridgeToken}`);
  lines.push('');
  lines.push(
    webPresenceLine(),
  );
  lines.push(`  Projects root: ${config.projectsRoot}`);
  lines.push(rule);
  lines.push('');
  // eslint-disable-next no-console
  console.log(lines.join('\n'));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // First thing: a server that takes over right after this one (service restart)
    // must find the file free, not still naming a process that is on its way out.
    removePidFile(config.dataDir);
    manager.stopAll();
    await tunnel.stop().catch(() => undefined);
    io.close();
    try {
      await app.close();
    } catch {
      // already closed
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

  // Last, once SIGTERM is handled: whoever sees this file may stop the server
  // right away. The CLI and the desktop shell find (and stop) a detached server
  // through it; it is removed on a clean exit and checked for staleness by readers.
  try {
    const result = writePidFile(config.dataDir);
    if (!result.written) {
      logger.warn(
        { otherPid: result.otherPid },
        'another AgentDeck server is running with this data dir — server.pid stays with it (two servers on one data dir are not supported)',
      );
    }
    process.once('exit', () => removePidFile(config.dataDir));
  } catch (err) {
    logger.warn({ err }, 'could not write server.pid');
  }
}

function webPresenceLine(): string {
  return findWebDist()
    ? '  Web app:   serving built assets from web/dist'
    : '  Web app:   NOT BUILT — run `npm run build -w web` (fallback page served at /)';
}

/** Runs the server until it is stopped; a failed start prints the error and exits non-zero. */
export function serve(): Promise<void> {
  return main().catch((err) => {
    // eslint-disable-next no-console
    console.error('AgentDeck failed to start:', err);
    process.exit(1);
  });
}
