import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchTree, type TreeWatcher } from '../src/files/treeWatch.js';

const WAIT = { timeout: 3000, interval: 25 };
let tree: TreeWatcher | null = null;

afterEach(() => {
  tree?.close();
  tree = null;
});

async function watched(maxDirs?: number) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-tree-'));
  const seen: string[] = [];
  let capped = 0;
  await fsp.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  tree = watchTree(root, {
    onChange: (_type, rel) => seen.push(rel),
    onError: () => undefined,
    onCapped: () => capped++,
    maxDirs,
  });
  // The initial scan of existing folders is asynchronous.
  await new Promise((r) => setTimeout(r, 100));
  return { root, seen, capped: () => capped };
}

describe.skipIf(process.platform !== 'linux')('watchTree', () => {
  it('reports files in existing and freshly created folders', async () => {
    const { root, seen } = await watched();
    await fsp.writeFile(path.join(root, 'src', 'a.ts'), 'x');
    await fsp.mkdir(path.join(root, 'new', 'deep'), { recursive: true });
    await fsp.writeFile(path.join(root, 'new', 'deep', 'b.ts'), 'x');
    await vi.waitFor(() => {
      expect(seen).toContain('src/a.ts');
      expect(seen).toContain('new/deep/b.ts');
    }, WAIT);
  });

  it('does not descend into dependency folders', async () => {
    const { root, seen } = await watched();
    await fsp.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'x');
    await fsp.writeFile(path.join(root, 'marker.txt'), 'x');
    await vi.waitFor(() => expect(seen).toContain('marker.txt'), WAIT);
    expect(seen.filter((p) => p.startsWith('node_modules/'))).toEqual([]);
  });

  it('stops at the folder limit', async () => {
    const { capped } = await watched(1);
    expect(capped()).toBe(1);
  });
});
