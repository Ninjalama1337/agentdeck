import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveInsideRoot } from '../src/files/sandbox.js';

let root = '';

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-sandbox-'));
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.writeFile(path.join(root, 'src', 'app.ts'), 'export {};\n');
  // Real symlink pointing OUTSIDE the sandbox root.
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-outside-'));
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'top secret');
  await fsp.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('resolveInsideRoot', () => {
  it('resolves plain relative paths', async () => {
    const res = await resolveInsideRoot(root, 'src/app.ts');
    expect(res.abs).toBe(path.join(await fsp.realpath(root), 'src', 'app.ts'));
    expect(res.rel).toBe(path.join('src', 'app.ts'));
  });

  it('blocks ../ traversal', async () => {
    await expect(resolveInsideRoot(root, '../outside')).rejects.toMatchObject({ statusCode: 403 });
    await expect(resolveInsideRoot(root, 'src/../../..')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('blocks absolute path injection', async () => {
    await expect(resolveInsideRoot(root, '/etc/passwd')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('blocks symlink escapes', async () => {
    await expect(resolveInsideRoot(root, 'leak.txt')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('blocks symlink escapes through a not-yet-existing file name', async () => {
    await expect(resolveInsideRoot(root, 'src/../../..')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows non-existing targets inside the root (upload destinations)', async () => {
    const res = await resolveInsideRoot(root, 'src/new-file.ts');
    expect(res.rel).toBe(path.join('src', 'new-file.ts'));
  });

  it('creates the root on demand when create is set', async () => {
    const fresh = path.join(root, 'fresh-project');
    const res = await resolveInsideRoot(fresh, '', { create: true });
    expect(res.root).toBe(await fsp.realpath(fresh));
  });
});
