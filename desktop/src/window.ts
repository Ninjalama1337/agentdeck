import { BrowserWindow, screen, shell, type Display } from 'electron';
import { classifyNavigation } from './core/urlPolicy';
import { readJsonFile, writeFileAtomic, type FileSystem } from './core/fs';
import {
  MIN_WINDOW_SIZE,
  normalizeWindowState,
  resolveWindowState,
  type DisplayInfo,
  type WindowState,
} from './core/windowState';

/** Fixed browser partition: the profile (localStorage, IndexedDB, service worker) lives under userData/Partitions/agentdeck. */
export const PARTITION = 'persist:agentdeck';

const BACKGROUND = '#0b0e14';

function displayInfo(d: Display): DisplayInfo {
  return { id: d.id, bounds: d.bounds, workArea: d.workArea };
}

export interface MainWindowOptions {
  fs: FileSystem;
  stateFile: string;
  preload: string;
  icon: string;
  /** The server's origin — the only place the window may navigate to. */
  origin: string;
  devTools: boolean;
  log(message: string): void;
}

/** Remembers size, position, maximized/fullscreen state and screen across runs. */
class WindowStateKeeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly win: BrowserWindow,
    private readonly options: MainWindowOptions,
  ) {
    const schedule = (): void => this.schedule();
    win.on('resize', schedule);
    win.on('move', schedule);
    win.on('maximize', schedule);
    win.on('unmaximize', schedule);
    win.on('enter-full-screen', schedule);
    win.on('leave-full-screen', schedule);
    win.on('close', () => void this.saveNow());
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.saveNow(), 500);
  }

  async saveNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.win.isDestroyed()) return;
    // The un-maximized rectangle, so leaving maximize/fullscreen later restores a sensible window.
    const bounds = this.win.getNormalBounds();
    const display = screen.getDisplayMatching(this.win.getBounds());
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: this.win.isMaximized(),
      fullScreen: this.win.isFullScreen(),
      displayId: display.id,
      displayBounds: display.bounds,
    };
    try {
      await writeFileAtomic(this.options.fs, this.options.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    } catch (err) {
      this.options.log(`cannot save the window state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Creates the one window, in the state it was closed in; shown once it is ready. */
export async function createMainWindow(options: MainWindowOptions): Promise<{ win: BrowserWindow; keeper: { saveNow(): Promise<void> } }> {
  const saved = normalizeWindowState(await readJsonFile(options.fs, options.stateFile));
  const resolved = resolveWindowState(saved, screen.getAllDisplays().map(displayInfo), displayInfo(screen.getPrimaryDisplay()));

  const win = new BrowserWindow({
    width: resolved.width,
    height: resolved.height,
    ...(resolved.x !== undefined && resolved.y !== undefined ? { x: resolved.x, y: resolved.y } : {}),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    backgroundColor: BACKGROUND,
    title: 'AgentDeck',
    icon: options.icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preload,
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  if (resolved.maximized) win.maximize();
  if (resolved.fullScreen) win.setFullScreen(true);
  win.once('ready-to-show', () => win.show());

  const keeper = new WindowStateKeeper(win, options);
  guardNavigation(win, options);
  return { win, keeper };
}

/** Only the server's origin loads in the window; web links open in the system browser. */
function guardNavigation(win: BrowserWindow, options: MainWindowOptions): void {
  const wc = win.webContents;
  const openExternal = (url: string): void => {
    shell.openExternal(url).catch((err: unknown) => options.log(`cannot open ${url}: ${String(err)}`));
  };
  wc.setWindowOpenHandler(({ url }) => {
    if (classifyNavigation(url, options.origin) !== 'block') openExternal(url);
    return { action: 'deny' };
  });
  const onNavigate = (event: Electron.Event, url: string): void => {
    const verdict = classifyNavigation(url, options.origin);
    if (verdict === 'allow') return;
    event.preventDefault();
    if (verdict === 'external') openExternal(url);
  };
  wc.on('will-navigate', onNavigate);
  wc.on('will-redirect', onNavigate);
  wc.on('will-attach-webview', (event) => event.preventDefault());
  if (!options.devTools) wc.on('devtools-opened', () => wc.closeDevTools());
}
