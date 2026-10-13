import { describe, expect, it } from 'vitest';
import { filesFromTransfer } from '../src/util/incomingFiles';
import { pathInput, promptPath } from '../src/features/code/termPath';

function transfer(files: File[], types: string[]): DataTransfer {
  return { files: Object.assign(files, { item: (i: number) => files[i] ?? null }), types } as unknown as DataTransfer;
}

describe('filesFromTransfer', () => {
  it('takes a pasted screenshot and gives it a usable name', () => {
    const [file] = filesFromTransfer(transfer([new File(['x'], 'image.png', { type: 'image/png' })], ['Files']));
    expect(file?.name).toMatch(/^screenshot-\d{8}-\d{6}\.png$/);
    expect(file?.type).toBe('image/png');
  });

  it('keeps the name of a real file', () => {
    const [file] = filesFromTransfer(transfer([new File(['x'], 'report.pdf', { type: 'application/pdf' })], ['Files']));
    expect(file?.name).toBe('report.pdf');
  });

  it('leaves a paste alone that is text with a picture of it next to it', () => {
    expect(filesFromTransfer(transfer([new File(['x'], 'image.png', { type: 'image/png' })], ['text/plain', 'text/html', 'Files']))).toEqual([]);
    expect(filesFromTransfer(transfer([], ['text/plain']))).toEqual([]);
    expect(filesFromTransfer(null)).toEqual([]);
  });
});

describe('terminal path input', () => {
  it('types a plain path as it is and quotes one with spaces', () => {
    expect(promptPath('/home/u/.local/share/agentdeck/attachments/terminal-t_1/f_1__shot.png')).toBe(
      '/home/u/.local/share/agentdeck/attachments/terminal-t_1/f_1__shot.png',
    );
    expect(promptPath("/home/my user/it's.png")).toBe(`'/home/my user/it'\\''s.png'`);
  });

  it('wraps the path in a paste for agents only', () => {
    expect(pathInput('/a/b.png', true)).toBe('\u001b[200~/a/b.png\u001b[201~ ');
    expect(pathInput('/a/b.png', false)).toBe('/a/b.png ');
  });
});
