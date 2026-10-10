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
  /** The installed unit, if any (see collectInfo). */
  unitPath?: string;
  version?: string;
  packaged?: boolean;
  webDist?: string | undefined;
}

/**
 * Config and env resolved the way the server resolves them — for the server
 * that will actually run:
 *  - With a unit written by `service install`, the answer is what the SERVICE
 *    sees: the unit's own environment (AGENTDECK_HOST, AGENTDECK_PORT) plus
 *    config.json at its default location. AGENTDECK_* variables of the caller's
 *    shell (data dir, port, host, config path …) are ignored — the service never
 *    gets them, and reading the pairing code or pid file from the wrong place
 *    would be worse than a wrong port. As for the service itself, the unit's
 *    AGENTDECK_HOST (loopback unless `--lan`) wins over `host` in config.json.
 *  - Without such a unit (a checkout, a manual start, a detached server) it is
 *    the caller's environment plus config.json, as for a server started here.
 */
export function collectInfo(opts: InfoOptions = {}): ServerCliInfo {
  let env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  if (opts.unitPath) {
    try {
      const unit = parseUnit(fs.readFileSync(opts.unitPath, 'utf8'));
      if (unit.managed) {
        env = {
          ...(unit.host !== undefined ? { AGENTDECK_HOST: unit.host } : {}),
          ...(unit.port !== undefined ? { AGENTDECK_PORT: String(unit.port) } : {}),
        };
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
