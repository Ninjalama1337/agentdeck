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

/** Stopping the server failed: leave anyway (it keeps running) or stay in the app. */
export async function stopFailed(win: BrowserWindow | null, message: string): Promise<'quit-anyway' | 'cancel'> {
  const result = await box(win, {
    type: 'error',
    title: TEXTS.appName,
    message: TEXTS.stopFailed,
    detail: message,
    buttons: [TEXTS.stopFailedQuit, TEXTS.cancel],
    defaultId: 1,
    cancelId: 1,
  });
  return result.response === 0 ? 'quit-anyway' : 'cancel';
}

export async function showError(win: BrowserWindow | null, message: string, detail: string): Promise<void> {
  await box(win, { type: 'error', title: TEXTS.appName, message, detail, buttons: ['OK'] });
}

export type UpdateAnswer = 'install' | 'later' | 'ignore';

/** A newer release exists: download it now, ask again next start, or skip this version. */
export async function updateAvailable(win: BrowserWindow | null, version: string): Promise<UpdateAnswer> {
  const t = TEXTS.update;
  const result = await box(win, {
    type: 'info',
    title: TEXTS.appName,
    message: t.availableMessage(version),
    detail: t.availableDetail,
    buttons: [t.install, t.later, t.ignore],
    defaultId: 0,
    cancelId: 1,
  });
  return (['install', 'later', 'ignore'] as const)[result.response] ?? 'later';
}

export type UpdateReadyAnswer = 'restart' | 'later';

/** The update is downloaded: restart into it now, or wait for the next start. */
export async function updateReady(win: BrowserWindow | null, version: string): Promise<UpdateReadyAnswer> {
  const t = TEXTS.update;
  const result = await box(win, {
    type: 'info',
    title: TEXTS.appName,
    message: t.readyMessage(version),
    detail: t.readyDetail,
    buttons: [t.restart, t.later],
    defaultId: 0,
    cancelId: 1,
  });
  return result.response === 0 ? 'restart' : 'later';
}

/** The chosen install could not be prepared (offline, or no permission to write). */
export async function updateFailed(win: BrowserWindow | null, message: string): Promise<void> {
  await box(win, { type: 'error', title: TEXTS.appName, message: TEXTS.update.failed, detail: message, buttons: ['OK'] });
}
