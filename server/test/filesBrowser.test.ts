import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guessMime, isInlineMime, listDirectory } from '../src/files/browser.js';

let root = '';

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-files-'));
  await fsp.mkdir(path.join(root, 'subdir', 'nested'), { recursive: true });
  await fsp.writeFile(path.join(root, 'subdir', 'nested', 'deep.txt'), 'deep');
  await fsp.writeFile(path.join(root, '.dotfile'), 'x');
  await fsp.writeFile(path.join(root, 'zebra.txt'), 'zebra');
  await fsp.writeFile(path.join(root, 'app.ts'), 'export {};\n');
  await fsp.writeFile(path.join(root, 'image.PNG'), 'png');
  await fsp.symlink(path.join(root, 'zebra.txt'), path.join(root, 'alias.txt'));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('listDirectory', () => {
  it('hides dotfiles by default and sorts dirs first', async () => {
    const entries = await listDirectory(root, '');
    const names = entries.map((e) => e.name);
    expect(names).not.toContain('.dotfile');
    expect(names[0]).toBe('subdir'); // dirs first
    const rest = names.slice(1);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });

  it('includes dotfiles with all=1', async () => {
    const entries = await listDirectory(root, '', { all: true });
    expect(entries.some((e) => e.name === '.dotfile')).toBe(true);
  });

  it('reports kind, size, ext and follows symlinked targets', async () => {
    const entries = await listDirectory(root, '');
    const dir = entries.find((e) => e.name === 'subdir');
    expect(dir?.kind).toBe('dir');
    const file = entries.find((e) => e.name === 'zebra.txt');
    expect(file?.kind).toBe('file');
    expect(file?.size).toBe(5);
    expect(file?.ext).toBe('txt');
    expect(file?.modifiedAt).toBeGreaterThan(0);
    const alias = entries.find((e) => e.name === 'alias.txt');
    expect(alias?.kind).toBe('file');
    expect(alias?.size).toBe(5);
    const ts = entries.find((e) => e.name === 'app.ts');
    expect(ts?.ext).toBe('ts');
  });

  it('builds project-relative paths for nested listings', async () => {
    const entries = await listDirectory(path.join(root, 'subdir'), 'subdir');
    const nested = entries.find((e) => e.name === 'nested');
    expect(nested?.path).toBe('subdir/nested');
  });

  it('throws 404 for missing directories', async () => {
    await expect(listDirectory(path.join(root, 'nope'), '')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('mime helpers', () => {
  it('guesses common mimes', () => {
    expect(guessMime('a.png')).toBe('image/png');
    expect(guessMime('a.txt')).toBe('text/plain; charset=utf-8');
    expect(guessMime('unknownbin')).toBe('application/octet-stream');
  });

  it('marks renderable mimes inline', () => {
    expect(isInlineMime('image/png')).toBe(true);
    expect(isInlineMime('text/plain')).toBe(true);
    expect(isInlineMime('application/json')).toBe(true);
    expect(isInlineMime('application/octet-stream')).toBe(false);
  });
});
