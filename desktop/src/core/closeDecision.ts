import type { DesktopCloseAction, DesktopServerMode } from './contract';

export interface CloseContext {
  closeAction: DesktopCloseAction;
  mode: DesktopServerMode;
  /** The app may stop this server (service or detached). */
  controllable: boolean;
}

export type CloseDecision =
  | { kind: 'ask' }
  /** Close without asking; `stopService` also stops the server. */
  | { kind: 'quit'; stopService: boolean };

/** Does "stop" make sense: the app can stop it and something is running. */
export function canStopServer(ctx: Pick<CloseContext, 'mode' | 'controllable'>): boolean {
  return ctx.controllable && (ctx.mode === 'service' || ctx.mode === 'detached');
}

/** What closing the window does for the user's `closeAction`. */
export function decideClose(ctx: CloseContext): CloseDecision {
  switch (ctx.closeAction) {
    case 'ask':
      return { kind: 'ask' };
    case 'background':
      return { kind: 'quit', stopService: false };
    case 'stop':
      // An external server (checkout, manual start) is not ours to stop — just close.
      return { kind: 'quit', stopService: canStopServer(ctx) };
  }
}

/** What is going on at the server right now; null counts mean "could not find out". */
export interface Activity {
  runs: number;
  terminals: number;
}

export type CloseChoice = 'background' | 'stop' | 'cancel';

export interface CloseDialogModel {
  title: string;
  message: string;
  detail: string;
  /** Button labels in display order. */
  buttons: string[];
  /** What each button does (same order). */
  choices: CloseChoice[];
  defaultId: number;
  cancelId: number;
  checkboxLabel: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function activityLine(activity: Activity | null): string {
  if (!activity) return '';
  if (activity.runs === 0 && activity.terminals === 0) return 'Gerade läuft kein Agent und kein Terminal.';
  const parts: string[] = [];
  if (activity.runs > 0) parts.push(plural(activity.runs, 'Agent-Lauf', 'Agent-Läufe'));
  if (activity.terminals > 0) parts.push(plural(activity.terminals, 'Terminal', 'Terminals'));
  return `Gerade laufen: ${parts.join(' und ')}.`;
}

/** The German close dialog: three buttons plus "don't ask again" — or two for a server the app cannot stop. */
export function buildCloseDialog(options: { canStop: boolean; activity: Activity | null }): CloseDialogModel {
  const { canStop, activity } = options;
  const lines: string[] = [];
  const status = activityLine(activity);
  if (status) lines.push(status, '');

  if (canStop) {
    lines.push(
      'Im Hintergrund weiterlaufen: Der Dienst bleibt aktiv. Agenten, Routinen und Benachrichtigungen laufen weiter, das Handy bleibt verbunden.',
      '',
      'Dienst stoppen und beenden: Der Server hält an, laufende Agent-Läufe werden unterbrochen.',
      '',
      'Terminals laufen in tmux weiter und sind nach dem nächsten Start wieder da.',
    );
    return {
      title: 'AgentDeck beenden',
      message: 'Was soll mit dem AgentDeck-Dienst passieren?',
      detail: lines.join('\n'),
      buttons: ['Im Hintergrund weiterlaufen', 'Dienst stoppen und beenden', 'Abbrechen'],
      choices: ['background', 'stop', 'cancel'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: 'Nicht mehr fragen',
    };
  }
  lines.push(
    'Der Server wurde nicht von AgentDeck gestartet und läuft weiter. Terminals laufen in tmux weiter.',
  );
  return {
    title: 'AgentDeck beenden',
    message: 'AgentDeck beenden?',
    detail: lines.join('\n'),
    buttons: ['Beenden', 'Abbrechen'],
    choices: ['background', 'cancel'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: 'Nicht mehr fragen',
  };
}

export interface CloseAnswer {
  choice: CloseChoice;
  /** Value for `closeAction` when "don't ask again" was ticked on a real choice. */
  remember: Exclude<DesktopCloseAction, 'ask'> | null;
}

/** Dialog result → what to do. Cancelling never remembers anything, ticked box or not. */
export function resolveCloseDialog(model: CloseDialogModel, response: number, checkboxChecked: boolean): CloseAnswer {
  const choice: CloseChoice = model.choices[response] ?? 'cancel';
  return { choice, remember: checkboxChecked && choice !== 'cancel' ? choice : null };
}
