import {
  buildCloseDialog,
  canStopServer,
  decideClose,
  resolveCloseDialog,
  type Activity,
  type CloseContext,
  type CloseDialogModel,
} from './closeDecision';
import type { DesktopCloseAction } from './contract';

export interface CloseFlowDeps {
  /** Current close setting and how the server runs. */
  context(): Promise<CloseContext>;
  /** Running agent runs / terminals, if the server can be asked. */
  activity(): Promise<Activity | null>;
  showDialog(model: CloseDialogModel): Promise<{ response: number; checkboxChecked: boolean }>;
  /** "Don't ask again" ticked: store the choice as the new close behaviour. */
  remember(action: Exclude<DesktopCloseAction, 'ask'>): Promise<void>;
  stopServer(): Promise<void>;
  /** Stopping failed — tell the user; the window stays open. */
  reportStopFailure(message: string): Promise<void>;
  /** Flush storage and exit the app. */
  quit(): Promise<void>;
}

export type CloseOutcome = 'quit' | 'cancelled' | 'failed';

async function stopThenQuit(deps: CloseFlowDeps, stop: boolean): Promise<CloseOutcome> {
  if (stop) {
    try {
      await deps.stopServer();
    } catch (err) {
      await deps.reportStopFailure(err instanceof Error ? err.message : String(err));
      return 'failed';
    }
  }
  await deps.quit();
  return 'quit';
}

/** The window is being closed: decide, maybe ask, then leave the server running or stop it. */
export async function runCloseFlow(deps: CloseFlowDeps): Promise<CloseOutcome> {
  const ctx = await deps.context();
  const decision = decideClose(ctx);
  if (decision.kind === 'quit') return stopThenQuit(deps, decision.stopService);

  const model = buildCloseDialog({ canStop: canStopServer(ctx), activity: await deps.activity() });
  const { response, checkboxChecked } = await deps.showDialog(model);
  const answer = resolveCloseDialog(model, response, checkboxChecked);
  if (answer.choice === 'cancel') return 'cancelled';
  if (answer.remember) await deps.remember(answer.remember);
  return stopThenQuit(deps, answer.choice === 'stop');
}

/** `DesktopBridge.quit()` — the web UI decided; no dialog. */
export async function runExplicitQuit(deps: CloseFlowDeps, options: { stopService?: boolean }): Promise<CloseOutcome> {
  const ctx = await deps.context();
  return stopThenQuit(deps, Boolean(options.stopService) && canStopServer(ctx));
}
