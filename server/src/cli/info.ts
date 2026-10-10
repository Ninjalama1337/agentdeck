/** `agentdeck-server info --json`: where this server lives, for the desktop shell and scripts. */
import fs from 'node:fs';
import path from 'node:path';
import type { ServerCliInfo } from '@agentdeck/shared';
import { loadConfig, resolveConfigPath } from '../config.js';
import { findWebDist } from '../http/webDist.js';
import { pidFilePath } from '../util/pidfile.js';
import { PACKAGED, VERSION } from '../version.js';
import { parseUnit } from './unit.js';

export interface InfoOptions {
  env?: NodeJS.ProcessEnv;
  /** The installed unit, if any: its AGENTDECK_PORT / AGENTDECK_HOST apply to the service when the caller's env sets none. */
  unitPath?: string;
  version?: string;
  packaged?: boolean;
  webDist?: string | undefined;
}

/**
 * Config and env resolved the way the server resolves them. One addition: an
 * installed service may pin port/host in its unit (`service install --port`,
 * `--lan`) — the caller's shell does not have those variables, but the service
 * does, so they count unless the caller's own env says otherwise.
 */
export function collectInfo(opts: InfoOptions = {}): ServerCliInfo {
  const env = { ...(opts.env ?? process.env) };
  if (opts.unitPath) {
    try {
      const unit = parseUnit(fs.readFileSync(opts.unitPath, 'utf8'));
      if (unit.managed) {
        if (!env.AGENTDECK_PORT && unit.port !== undefined) env.AGENTDECK_PORT = String(unit.port);
        if (!env.AGENTDECK_HOST && unit.host !== undefined) env.AGENTDECK_HOST = unit.host;
      }
    } catch {
      // no unit installed
    }
  }
  const config = loadConfig({ env });
  const webDist = 'webDist' in opts ? opts.webDist : findWebDist();
  return {
    version: opts.version ?? VERSION,
    packaged: opts.packaged ?? PACKAGED,
    dataDir: config.dataDir,
    configPath: resolveConfigPath({ env }),
    host: config.host,
    port: config.port,
    pairingCodeFile: path.join(config.dataDir, 'pairing-code.txt'),
    pidFile: pidFilePath(config.dataDir),
    ...(webDist ? { webDist } : {}),
  };
}
