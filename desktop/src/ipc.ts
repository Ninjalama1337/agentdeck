import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { CH, type InitInfo } from './channels';
import type { DesktopServerStatus, DesktopServiceAction, DesktopSettings } from './core/contract';
import type { PairOutcome } from './core/pairing';
import type { ServerState } from './core/serverStatus';
import { toPublicStatus, trust, type ServerHolder } from './core/serverStatus';
import { isTrustedSender } from './core/urlPolicy';

export interface IpcContext {
  origin: string;
  /** Who holds the server's port right now (a fresh look when the last one is old). */
  identify(): Promise<ServerHolder>;
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

  /**
   * `hand-out`: delivers the pairing code or the bridge — only to the AgentDeck server's own
   * pages. `call`: a page that has the bridge asks for something — not while a stranger holds the port.
   */
  function handle<T>(channel: string, gate: 'hand-out' | 'call', work: (event: IpcMainInvokeEvent, arg: unknown) => Promise<T>): void {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      if (!trusted(event)) throw new Error('Not allowed from this page.');
      const holder = await ctx.identify();
      if (!(gate === 'hand-out' ? trust.mayHandOut(holder) : trust.mayCall(holder))) {
        ctx.log(`${channel}: refused, the port is held by ${holder}`);
        throw new Error('The server on this port is not AgentDeck.');
      }
      try {
        return await work(event, arg);
      } catch (err) {
        ctx.log(`${channel}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  // The preload asks before the page runs: no bridge and no pairing unless an AgentDeck server answers.
  ipcMain.on(CH.init, (event) => {
    if (!trusted(event)) {
      event.returnValue = null;
      return;
    }
    const info: InitInfo = { origin: ctx.origin, appVersion: ctx.appVersion, platform: ctx.platform };
    ctx.identify().then(
      (holder) => {
        event.returnValue = trust.mayHandOut(holder) ? info : null;
      },
      () => {
        event.returnValue = null;
      },
    );
  });

  // The page is waiting for this one (preload runs before the web app reads its login).
  ipcMain.on(CH.pairSync, (event) => {
    if (!trusted(event)) {
      event.returnValue = null;
      return;
    }
    ctx
      .identify()
      .then((holder) => (trust.mayHandOut(holder) ? ctx.pair() : null))
      .then(
        (outcome) => {
          event.returnValue = outcome;
        },
        () => {
          event.returnValue = null;
        },
      );
  });

  handle(CH.pairAgain, 'hand-out', () => ctx.pair());
  handle(CH.getSettings, 'call', () => ctx.getSettings());
  handle(CH.setSettings, 'call', (_event, patch) => ctx.setSettings(patch));
  handle(CH.getServerStatus, 'call', async () => toPublicStatus(await ctx.getStatus()));
  handle(CH.serviceAction, 'call', async (_event, action) => {
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) throw new Error('Unknown action.');
    return toPublicStatus(await ctx.serviceAction(action as DesktopServiceAction));
  });
  handle(CH.quit, 'call', async (_event, options) => {
    const stopService = Boolean((options as { stopService?: unknown } | null)?.stopService);
    // Answer first: quitting tears the window (and this reply) down.
    setTimeout(() => void ctx.quit({ stopService }), 0);
  });
}

export function publicStatus(state: ServerState): DesktopServerStatus {
  return toPublicStatus(state);
}
