import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFs, writeFileAtomic } from '../src/core/fs';
import { SettingsStore } from '../src/core/settings';
import { MemFs } from './helpers/memFs';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-fs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('survives many parallel writers of one file (real file system)', async () => {
    const file = path.join(dir, 'state', 'window-state.json');
    const writes = Array.from({ length: 200 }, (_, i) => writeFileAtomic(nodeFs, file, JSON.stringify({ n: i })));
    await expect(Promise.all(writes)).resolves.toHaveLength(200);
    // in call order: the last call wins
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 199 });
    expect((await readdir(path.dirname(file))).sort()).toEqual(['window-state.json']);
  });

  it('three parallel SettingsStore.update() calls all succeed and the file holds the last state', async () => {
    const store = new SettingsStore(nodeFs, path.join(dir, 'settings.json'));
    await store.load();
    for (let round = 0; round < 50; round++) {
      await Promise.all([
        store.update({ closeAction: 'background' }),
        store.update({ lanAccess: round % 2 === 0 }),
        store.update({ launchAtLogin: round % 3 === 0 }),
      ]);
    }
    const onDisk = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'));
    expect(onDisk).toEqual(store.get());
    expect(onDisk.closeAction).toBe('background');
  });

  it('different files do not wait for each other, and a failed write does not stop the queue', async () => {
    const fs = new MemFs();
    const realWrite = fs.writeFile.bind(fs);
    let failNext = true;
    fs.writeFile = async (file, data, mode) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      return realWrite(file, data, mode);
    };
    const first = writeFileAtomic(fs, '/a.json', '1');
    const second = writeFileAtomic(fs, '/a.json', '2');
    const other = writeFileAtomic(fs, '/b.json', 'b');
    await expect(first).rejects.toThrow('disk full');
    await second;
    await other;
    expect(await fs.readFile('/a.json')).toBe('2');
    expect(await fs.readFile('/b.json')).toBe('b');
    expect([...fs.files.keys()].some((f) => f.includes('.tmp-'))).toBe(false);
  });

  it('uses a temp name of its own for every write', async () => {
    const fs = new MemFs();
    const seen = new Set<string>();
    const realWrite = fs.writeFile.bind(fs);
    fs.writeFile = async (file, data, mode) => {
      seen.add(file);
      return realWrite(file, data, mode);
    };
    await Promise.all([writeFileAtomic(fs, '/x', '1'), writeFileAtomic(fs, '/x', '2'), writeFileAtomic(fs, '/x', '3')]);
    expect(seen.size).toBe(3);
  });
});
