/**
 * Mouse report encoding of a server-side screen, for replay snapshots.
 *
 * The serialize addon restores mouse *tracking* (?1000h etc.) but not the
 * *encoding* (?1006h SGR, ?1005h UTF-8, ?1015h urxvt). A client repainted from
 * such a snapshot reports the mouse in X10 bytes: columns past ~95 turn into
 * multi-byte UTF-8 on the wire, tmux (`mouse on`) misplaces every click, drag
 * and wheel there — no scrolling, no selection — until a resize makes tmux
 * resend its modes. Tracking the encoding here closes that gap.
 */
import type xtermHeadless from '@xterm/headless';

const ENCODINGS = [1005, 1006, 1015] as const;

export interface MouseEncoding {
  /** DECSET sequence restoring the current encoding ('' = X10 default). */
  modes: () => string;
  dispose: () => void;
}

export function trackMouseEncoding(screen: InstanceType<typeof xtermHeadless.Terminal>): MouseEncoding {
  let encoding: number | null = null;
  const apply = (params: (number | number[])[], set: boolean): void => {
    for (const p of params) {
      if (typeof p !== 'number' || !(ENCODINGS as readonly number[]).includes(p)) continue;
      if (set) encoding = p;
      else if (encoding === p) encoding = null;
    }
  };
  const setHandler = screen.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    apply(params, true);
    return false; // the emulator keeps its default DECSET handling
  });
  const resetHandler = screen.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    apply(params, false);
    return false;
  });
  // RIS (ESC c) drops back to the X10 default.
  const resetAll = screen.parser.registerEscHandler({ final: 'c' }, () => {
    encoding = null;
    return false;
  });
  return {
    modes: () => (encoding === null ? '' : `\u001b[?${encoding}h`),
    dispose: () => {
      setHandler.dispose();
      resetHandler.dispose();
      resetAll.dispose();
    },
  };
}
