import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { answerPixelQueries, PIXEL_QUERIES, pixelReply } from '../src/term/pixelSize.js';

describe('pixel-size replies', () => {
  it('reports the text area and the cell in pixels', () => {
    expect(pixelReply(14, 80, 24, { width: 7, height: 16 })).toBe('\u001b[4;384;560t');
    expect(pixelReply(16, 80, 24, { width: 7, height: 16 })).toBe('\u001b[6;16;7t');
    expect(pixelReply(18, 80, 24, { width: 7, height: 16 })).toBeNull();
  });

  it('answers what tmux asks on attach', async () => {
    const screen = new xtermHeadless.Terminal({ cols: 100, rows: 30, allowProposedApi: true, windowOptions: PIXEL_QUERIES });
    const replies: string[] = [];
    const cell = { width: 8, height: 18 };
    answerPixelQueries(screen, (r) => replies.push(r), () => cell);
    await new Promise<void>((r) => screen.write('\u001b[14t\u001b[18t', () => r()));
    expect(replies).toEqual(['\u001b[4;540;800t']);
  });
});
