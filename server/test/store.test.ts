import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '@agentdeck/shared';
import { Store } from '../src/state/store.js';

let dataDir = '';
let store: Store;

beforeAll(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-store-'));
  store = new Store(dataDir);
  await store.init();
});

afterAll(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('Store', () => {
  it('roundtrips projects across instances', async () => {
    const project = await store.saveProject({
      id: 'p_rt',
      name: 'roundtrip',
      path: '/tmp/rt',
      createdAt: 1,
      updatedAt: 1,
    });
    expect(project.id).toBe('p_rt');

    const second = new Store(dataDir);
    await second.init();
    expect(second.getProject('p_rt')?.name).toBe('roundtrip');
  });

  it('creates and lists sessions filtered by project', async () => {
    await store.saveProject({ id: 'p_a', name: 'a', path: '/tmp/a', createdAt: 1, updatedAt: 1 });
    await store.saveProject({ id: 'p_b', name: 'b', path: '/tmp/b', createdAt: 1, updatedAt: 1 });
    const s1 = await store.newSession({ projectId: 'p_a', agentId: 'claude' });
    await store.newSession({ projectId: 'p_b', agentId: 'codex' });
    const forA = store.listSessions('p_a');
    expect(forA).toHaveLength(1);
    expect(forA[0]?.id).toBe(s1.id);
    expect(store.listSessions()).toHaveLength(2);
  });

  it('persists session source and resumes it from disk', async () => {
    const project = store.listProjects()[0];
    const session = await store.newSession({ projectId: project.id, agentId: 'zcode' }, 'team');
    const second = new Store(dataDir);
    await second.init();
    expect(second.getSession(session.id)).toBeDefined();
  });

  it('appends and reads messages sorted by ts', async () => {
    const session = store.listSessions()[0];
    await store.appendMessage({
      id: 'm_2',
      sessionId: session.id,
      role: 'assistant',
      text: 'second',
      attachments: [],
      ts: 2000,
    });
    await store.appendMessage({
      id: 'm_1',
      sessionId: session.id,
      role: 'user',
      text: 'first',
      attachments: [],
      ts: 1000,
    });
    const messages = await store.getMessages(session.id);
    expect(messages.map((m) => m.id)).toEqual(['m_1', 'm_2']);
  });

  it('deletes sessions including their files', async () => {
    const project = store.listProjects()[0];
    const session = await store.newSession({ projectId: project.id, agentId: 'claude' });
    await store.appendMessage({
      id: 'm_x',
      sessionId: session.id,
      role: 'user',
      text: 'x',
      attachments: [],
      ts: 1,
    });
    const dir = path.join(dataDir, 'sessions', session.id);
    await expect(fsp.stat(dir)).resolves.toBeDefined();
    expect(await store.deleteSession(session.id)).toBe(true);
    await expect(fsp.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.getSession(session.id)).toBeUndefined();
    expect(await store.getMessages(session.id)).toEqual([]);
  });

  it('notifies change subscribers', async () => {
    const events: string[] = [];
    const off = store.onChange((change) => events.push(change.kind));
    await store.saveProject({ id: 'p_evt', name: 'evt', path: '/tmp/e', createdAt: 1, updatedAt: 1 });
    off();
    await store.saveProject({ id: 'p_evt2', name: 'evt2', path: '/tmp/e2', createdAt: 1, updatedAt: 1 });
    expect(events).toEqual(['project']);
  });

  it('finds uploaded attachments by id prefix', async () => {
    const project = store.listProjects()[0];
    const session = await store.newSession({ projectId: project.id, agentId: 'claude' });
    const dir = store.attachmentsDirFor(session.id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'f_abc__pic.png'), 'png');
    const found = await store.findAttachment(session, project, 'f_abc');
    expect(found?.name).toBe('pic.png');
    expect(await store.findAttachment(session, project, 'f_nope')).toBeUndefined();
  });

  it('resets sessions left running by a restart and tells the user', async () => {
    await store.saveProject({ id: 'p_rec', name: 'rec', path: '/tmp/rec', createdAt: 1, updatedAt: 1 });
    const session = await store.newSession({ projectId: 'p_rec', agentId: 'claude' });
    await store.saveSession({ ...session, status: 'running' });

    const restarted = new Store(dataDir);
    await restarted.init();
    expect(restarted.getSession(session.id)?.status).toBe('idle');
    const messages = await restarted.getMessages(session.id);
    expect(messages.at(-1)?.role).toBe('system');
    expect(messages.at(-1)?.text).toMatch(/restarted/);
  });
});
