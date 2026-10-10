import { describe, expect, it } from 'vitest';
import {
  buildCloseDialog,
  canStopServer,
  decideClose,
  resolveCloseDialog,
  type Activity,
} from '../src/core/closeDecision';
import { runCloseFlow, runExplicitQuit, type CloseFlowDeps } from '../src/core/closeFlow';
import type { DesktopCloseAction, DesktopServerMode } from '../src/core/contract';

describe('decideClose', () => {
  it('asks when the setting says ask', () => {
    expect(decideClose({ closeAction: 'ask', mode: 'service', controllable: true, lan: false })).toEqual({ kind: 'ask' });
  });

  it('background keeps the server running', () => {
    expect(decideClose({ closeAction: 'background', mode: 'service', controllable: true, lan: false })).toEqual({ kind: 'quit', stopService: false });
  });

  it('stop stops what the app may stop', () => {
    expect(decideClose({ closeAction: 'stop', mode: 'service', controllable: true, lan: false })).toEqual({ kind: 'quit', stopService: true });
    expect(decideClose({ closeAction: 'stop', mode: 'detached', controllable: true, lan: false })).toEqual({ kind: 'quit', stopService: true });
  });

  it('stop on an external server only closes the app', () => {
    expect(decideClose({ closeAction: 'stop', mode: 'external', controllable: false, lan: false })).toEqual({ kind: 'quit', stopService: false });
    expect(decideClose({ closeAction: 'stop', mode: 'stopped', controllable: true, lan: false })).toEqual({ kind: 'quit', stopService: false });
  });

  it('stopping is only offered for service and detached servers', () => {
    expect(canStopServer({ mode: 'service', controllable: true })).toBe(true);
    expect(canStopServer({ mode: 'detached', controllable: true })).toBe(true);
    expect(canStopServer({ mode: 'external', controllable: false })).toBe(false);
    expect(canStopServer({ mode: 'stopped', controllable: true })).toBe(false);
  });
});

describe('buildCloseDialog', () => {
  it('has the three buttons, a default of "keep running" and the checkbox', () => {
    const model = buildCloseDialog({ canStop: true, lan: false, activity: { runs: 2, terminals: 1 } });
    expect(model.buttons).toEqual(['Im Hintergrund weiterlaufen', 'Dienst stoppen und beenden', 'Abbrechen']);
    expect(model.choices).toEqual(['background', 'stop', 'cancel']);
    expect(model.defaultId).toBe(0);
    expect(model.cancelId).toBe(2);
    expect(model.checkboxLabel).toBe('Nicht mehr fragen');
  });

  it('names the running agent runs and terminals', () => {
    expect(buildCloseDialog({ canStop: true, lan: false, activity: { runs: 2, terminals: 1 } }).detail).toContain('Gerade laufen: 2 Agent-Läufe und 1 Terminal.');
    expect(buildCloseDialog({ canStop: true, lan: false, activity: { runs: 1, terminals: 0 } }).detail).toContain('Gerade laufen: 1 Agent-Lauf.');
    expect(buildCloseDialog({ canStop: true, lan: false, activity: { runs: 0, terminals: 3 } }).detail).toContain('Gerade laufen: 3 Terminals.');
    expect(buildCloseDialog({ canStop: true, lan: false, activity: { runs: 0, terminals: 0 } }).detail).toContain('Gerade läuft kein Agent und kein Terminal.');
  });

  it('leaves the numbers out when the server cannot be asked', () => {
    const detail = buildCloseDialog({ canStop: true, lan: false, activity: null }).detail;
    expect(detail).not.toContain('Gerade');
  });

  it('promises the phone stays connected only with LAN access', () => {
    expect(buildCloseDialog({ canStop: true, lan: true, activity: null }).detail).toContain('das Handy bleibt verbunden');
    const neutral = buildCloseDialog({ canStop: true, lan: false, activity: null }).detail;
    expect(neutral).not.toContain('Handy');
    expect(neutral).toContain('Agenten, Routinen und Benachrichtigungen laufen weiter.');
  });

  it('says that terminals keep running in tmux', () => {
    expect(buildCloseDialog({ canStop: true, lan: false, activity: null }).detail).toContain('Terminals laufen in tmux weiter');
    expect(buildCloseDialog({ canStop: false, lan: false, activity: null }).detail).toContain('tmux');
  });

  it('offers no stop button for a server the app does not control', () => {
    const model = buildCloseDialog({ canStop: false, lan: false, activity: null });
    expect(model.buttons).toEqual(['Beenden', 'Abbrechen']);
    expect(model.choices).toEqual(['background', 'cancel']);
    expect(model.cancelId).toBe(1);
    expect(model.detail).toContain('nicht von AgentDeck gestartet');
  });
});

describe('resolveCloseDialog', () => {
  const model = buildCloseDialog({ canStop: true, lan: false, activity: null });

  it('maps the pressed button', () => {
    expect(resolveCloseDialog(model, 0, false)).toEqual({ choice: 'background', remember: null });
    expect(resolveCloseDialog(model, 1, false)).toEqual({ choice: 'stop', remember: null });
    expect(resolveCloseDialog(model, 2, false)).toEqual({ choice: 'cancel', remember: null });
  });

  it('remembers the choice when "don\'t ask again" is ticked', () => {
    expect(resolveCloseDialog(model, 0, true)).toEqual({ choice: 'background', remember: 'background' });
    expect(resolveCloseDialog(model, 1, true)).toEqual({ choice: 'stop', remember: 'stop' });
  });

  it('never remembers a cancel, and treats an unknown answer as cancel', () => {
    expect(resolveCloseDialog(model, 2, true)).toEqual({ choice: 'cancel', remember: null });
    expect(resolveCloseDialog(model, 99, true)).toEqual({ choice: 'cancel', remember: null });
  });
});

function flow(options: {
  closeAction?: DesktopCloseAction;
  mode?: DesktopServerMode;
  controllable?: boolean;
  response?: number;
  checkbox?: boolean;
  activity?: Activity | null;
  stopFails?: boolean;
  /** Answer to "stopping failed": quit anyway or stay. */
  onStopFailed?: 'quit-anyway' | 'cancel';
  lan?: boolean;
}) {
  const events: string[] = [];
  const deps: CloseFlowDeps = {
    context: async () => ({ closeAction: options.closeAction ?? 'ask', mode: options.mode ?? 'service', controllable: options.controllable ?? true, lan: options.lan ?? false }),
    activity: async () => options.activity ?? null,
    showDialog: async (model) => {
      events.push(`dialog:${model.buttons.length}`);
      return { response: options.response ?? 0, checkboxChecked: options.checkbox ?? false };
    },
    remember: async (action) => {
      events.push(`remember:${action}`);
    },
    stopServer: async () => {
      events.push('stop');
      if (options.stopFails) throw new Error('systemctl failed');
    },
    stopFailed: async (message) => {
      events.push(`stop-failed:${message}`);
      return options.onStopFailed ?? 'cancel';
    },
    quit: async () => {
      events.push('quit');
    },
  };
  return { deps, events };
}

describe('runCloseFlow', () => {
  it('"keep running" quits without stopping', async () => {
    const { deps, events } = flow({});
    expect(await runCloseFlow(deps)).toBe('quit');
    expect(events).toEqual(['dialog:3', 'quit']);
  });

  it('"stop" stops first, then quits', async () => {
    const { deps, events } = flow({ response: 1 });
    expect(await runCloseFlow(deps)).toBe('quit');
    expect(events).toEqual(['dialog:3', 'stop', 'quit']);
  });

  it('cancel leaves everything as it is', async () => {
    const { deps, events } = flow({ response: 2, checkbox: true });
    expect(await runCloseFlow(deps)).toBe('cancelled');
    expect(events).toEqual(['dialog:3']);
  });

  it('stores the choice when "don\'t ask again" is ticked', async () => {
    const { deps, events } = flow({ response: 1, checkbox: true });
    await runCloseFlow(deps);
    expect(events).toEqual(['dialog:3', 'stop', 'remember:stop', 'quit']);
  });

  it('does not ask when the close behaviour is fixed', async () => {
    const bg = flow({ closeAction: 'background' });
    expect(await runCloseFlow(bg.deps)).toBe('quit');
    expect(bg.events).toEqual(['quit']);
    const stop = flow({ closeAction: 'stop' });
    await runCloseFlow(stop.deps);
    expect(stop.events).toEqual(['stop', 'quit']);
  });

  it('closing an external server never stops it', async () => {
    const { deps, events } = flow({ closeAction: 'stop', mode: 'external', controllable: false, lan: false });
    await runCloseFlow(deps);
    expect(events).toEqual(['quit']);
  });

  it('shows the two-button dialog for an external server', async () => {
    const { deps, events } = flow({ mode: 'external', controllable: false, lan: false });
    await runCloseFlow(deps);
    expect(events).toEqual(['dialog:2', 'quit']);
  });

  it('keeps the window open when stopping fails and the user stays', async () => {
    const { deps, events } = flow({ response: 1, stopFails: true });
    expect(await runCloseFlow(deps)).toBe('failed');
    expect(events).toEqual(['dialog:3', 'stop', 'stop-failed:systemctl failed']);
  });

  it('quits anyway on request when stopping fails (the server keeps running)', async () => {
    const { deps, events } = flow({ response: 1, stopFails: true, onStopFailed: 'quit-anyway' });
    expect(await runCloseFlow(deps)).toBe('quit');
    expect(events).toEqual(['dialog:3', 'stop', 'stop-failed:systemctl failed', 'quit']);
  });

  it('remembers "don\'t ask again" only after the stop worked', async () => {
    const failed = flow({ response: 1, checkbox: true, stopFails: true, onStopFailed: 'cancel' });
    await runCloseFlow(failed.deps);
    expect(failed.events.some((e) => e.startsWith('remember'))).toBe(false);

    const failedButQuit = flow({ response: 1, checkbox: true, stopFails: true, onStopFailed: 'quit-anyway' });
    await runCloseFlow(failedButQuit.deps);
    expect(failedButQuit.events.some((e) => e.startsWith('remember'))).toBe(false);

    const worked = flow({ response: 1, checkbox: true });
    await runCloseFlow(worked.deps);
    expect(worked.events).toEqual(['dialog:3', 'stop', 'remember:stop', 'quit']);
  });

  it('a fixed stop that fails does not trap the user: the next close offers the same way out', async () => {
    const { deps, events } = flow({ closeAction: 'stop', stopFails: true, onStopFailed: 'quit-anyway' });
    expect(await runCloseFlow(deps)).toBe('quit');
    expect(events).toEqual(['stop', 'stop-failed:systemctl failed', 'quit']);
  });
});

describe('runExplicitQuit', () => {
  it('stops only when asked and allowed', async () => {
    const a = flow({});
    await runExplicitQuit(a.deps, { stopService: true });
    expect(a.events).toEqual(['stop', 'quit']);
    const b = flow({});
    await runExplicitQuit(b.deps, {});
    expect(b.events).toEqual(['quit']);
    const c = flow({ mode: 'external', controllable: false, lan: false });
    await runExplicitQuit(c.deps, { stopService: true });
    expect(c.events).toEqual(['quit']);
  });
});
