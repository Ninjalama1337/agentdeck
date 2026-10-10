import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';
import type { CloseDialogModel } from './core/closeDecision';
import { TEXTS } from './core/texts';

/** `dialog.showMessageBox` with or without a parent window (a dialog must not need the window to exist). */
async function box(win: BrowserWindow | null, options: MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const withIcon: MessageBoxOptions = { noLink: true, ...options };
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, withIcon) : dialog.showMessageBox(withIcon);
}

export async function askClose(win: BrowserWindow | null, model: CloseDialogModel): Promise<{ response: number; checkboxChecked: boolean }> {
  const result = await box(win, {
    type: 'question',
    title: model.title,
    message: model.message,
    detail: model.detail,
    buttons: model.buttons,
    defaultId: model.defaultId,
    cancelId: model.cancelId,
    checkboxLabel: model.checkboxLabel,
    checkboxChecked: false,
  });
  return { response: result.response, checkboxChecked: result.checkboxChecked };
}

/** First start: set up the background service? True = yes. */
export async function offerService(win: BrowserWindow | null): Promise<boolean> {
  const t = TEXTS.serviceOffer;
  const result = await box(win, {
    type: 'question',
    title: TEXTS.appName,
    message: t.message,
    detail: t.detail,
    buttons: [t.install, t.decline],
    defaultId: 0,
    cancelId: 1,
  });
  return result.response === 0;
}

/** The server would not start. True = try again, false = quit. */
export async function startFailed(win: BrowserWindow | null, message: string, detail: string): Promise<boolean> {
  const result = await box(win, {
    type: 'error',
    title: TEXTS.appName,
    message,
    detail,
    buttons: [TEXTS.retry, TEXTS.quit],
    defaultId: 0,
    cancelId: 1,
  });
  return result.response === 0;
}

export async function showError(win: BrowserWindow | null, message: string, detail: string): Promise<void> {
  await box(win, { type: 'error', title: TEXTS.appName, message, detail, buttons: ['OK'] });
}

export type UpdateAnswer = 'open' | 'later' | 'ignore';

export async function updateNotice(win: BrowserWindow | null, version: string): Promise<UpdateAnswer> {
  const t = TEXTS.update;
  const result = await box(win, {
    type: 'info',
    title: TEXTS.appName,
    message: t.message(version),
    detail: t.detail,
    buttons: [t.open, t.later, t.ignore],
    defaultId: 0,
    cancelId: 1,
  });
  return (['open', 'later', 'ignore'] as const)[result.response] ?? 'later';
}
