import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { trackMouseEncoding } from '../src/term/mouseEncoding.js';

function setup() {
  const screen = new xtermHeadless.Terminal({ cols: 120, rows: 10, allowProposedApi: true });
  const serializer = new serializeAddon.SerializeAddon();
  screen.loadAddon(serializer);
  const encoding = trackMouseEncoding(screen);
  const write = (data: string) => new Promise<void>((resolve) => screen.write(data, resolve));
  return { screen, serializer, encoding, write };
}

describe('mouse encoding in replay snapshots', () => {
  it('restores SGR encoding the serializer leaves out', async () => {
    const { serializer, encoding, write } = setup();
    // What tmux sends with `mouse on`: tracking + SGR, on the alternate screen.
    await write('\u001b[?1049h\u001b[?1000h\u001b[?1002h\u001b[?1006hhello');
    const snap = serializer.serialize();
    expect(snap).toContain('\u001b[?1002h');
    expect(snap).not.toContain('\u001b[?1006h');
    expect(encoding.modes()).toBe('\u001b[?1006h');

    // A client replaying snapshot + modes reports the mouse in SGR again.
    const client = setup();
    await client.write(snap + encoding.modes());
    expect(client.encoding.modes()).toBe('\u001b[?1006h');
  });

  it('forgets the encoding when it is reset', async () => {
    const { encoding, write } = setup();
    await write('\u001b[?1006h');
    await write('\u001b[?1006l');
    expect(encoding.modes()).toBe('');
    await write('\u001b[?1015h');
    expect(encoding.modes()).toBe('\u001b[?1015h');
    await write('\u001bc');
    expect(encoding.modes()).toBe('');
  });
});
