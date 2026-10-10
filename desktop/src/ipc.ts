import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { CH, type InitInfo } from './channels';
import type { DesktopServerStatus, DesktopServiceAction, DesktopSettings } from './core/contract';
import type { PairOutcome } from './core/pairing';
import type { ServerState } from './core/serverStatus';
import { toPublicStatus } from './core/serverStatus';
import { isTrustedSender } from './core/urlPolicy';

export interface IpcContext {
  origin: string;
  appVersion: string;
  platform: string;
  getStatus(): Promise<ServerState>;
  serviceAction(action: DesktopServiceAction): Promise<ServerState>;
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: unknown): Promise<DesktopSettings>;
  pair(): Promise<PairOutcome>;
  quit(options: { stopService: boolean }): Promise<void>;
  log(message: string): void;
}

const ACTIONS: readonly DesktopServiceAction[] = ['install', 'uninstall', 'start', 'stop', 'restart'];

/** URL of the frame that sent a message (empty when it is already gone). */
function senderUrl(event: IpcMainEvent | IpcMainInvokeEvent): string {
  return event.senderFrame?.url ?? '';
}

/** Registers every channel. Only pages of the server's own origin are answered. */
export function registerIpc(ctx: IpcContext): void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isTrustedSender(senderUrl(event), ctx.origin);

  function handle<T>(channel: string, work: (event: IpcMainInvokeEvent, arg: unknown) => Promise<T>): void {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      if (!trusted(event)) throw new Error('Not allowed from this page.');
      try {
        return await work(event, arg);
      } catch (err) {
        ctx.log(`${channel}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  ipcMain.on(CH.init, (event) => {
    const info: InitInfo = { origin: ctx.origin, appVersion: ctx.appVersion, platform: ctx.platform };
    event.returnValue = trusted(event) ? info : null;
  });

  // The page is waiting for this one (preload runs before the web app reads its login).
  ipcMain.on(CH.pairSync, (event) => {
    if (!trusted(event)) {
      event.returnValue = null;
      return;
    }
    ctx.pair().then(
      (outcome) => {
        event.returnValue = outcome;
      },
      () => {
        event.returnValue = null;
      },
    );
  });

  handle(CH.pairAgain, () => ctx.pair());
  handle(CH.getSettings, () => ctx.getSettings());
  handle(CH.setSettings, (_event, patch) => ctx.setSettings(patch));
  handle(CH.getServerStatus, async () => toPublicStatus(await ctx.getStatus()));
  handle(CH.serviceAction, async (_event, action) => {
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) throw new Error('Unknown action.');
    return toPublicStatus(await ctx.serviceAction(action as DesktopServiceAction));
  });
  handle(CH.quit, async (_event, options) => {
    const stopService = Boolean((options as { stopService?: unknown } | null)?.stopService);
    // Answer first: quitting tears the window (and this reply) down.
    setTimeout(() => void ctx.quit({ stopService }), 0);
  });
}

export function publicStatus(state: ServerState): DesktopServerStatus {
  return toPublicStatus(state);
}
