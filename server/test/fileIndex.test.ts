import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileIndex } from '../src/files/fileIndex.js';

function tree(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-index-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), 'x');
  }
  return root;
}

describe('fileIndex', () => {
  it('walks a plain folder and skips dependency folders', async () => {
    const root = tree(['a.ts', 'src/b.ts', 'node_modules/x/index.js', 'dist/out.js']);
    expect((await fileIndex(root)).paths.sort()).toEqual(['a.ts', 'src/b.ts']);
  });

  it('lists what git sees in a repository, ignores included', async () => {
    const root = tree(['a.ts', 'src/b.ts', 'secret.log', '.gitignore']);
    fs.writeFileSync(path.join(root, '.gitignore'), '*.log\n');
    execFileSync('git', ['init', '-q', root]);
    expect((await fileIndex(root)).paths.sort()).toEqual(['.gitignore', 'a.ts', 'src/b.ts']);
  });

  it('caps the list', async () => {
    const root = tree(['a', 'b', 'c']);
    const idx = await fileIndex(root, 2);
    expect(idx.paths).toHaveLength(2);
    expect(idx.truncated).toBe(true);
  });
});
