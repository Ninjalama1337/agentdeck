import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '@agentdeck/shared';
import { fitWithin, MAX_EDGE, renameForType } from '../src/util/imagePrep';

type Drafts = typeof import('../src/store/composerDrafts');

let storage: Map<string, string>;

/** Fresh module (it caches per page load) over the given storage. */
async function loadDrafts(keep = false): Promise<Drafts> {
  if (!keep) storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.resetModules();
  return import('../src/store/composerDrafts');
}

const shot: Attachment = { id: 'f_1', name: 'shot.png', mime: 'image/png', size: 10, url: '/api/x', kind: 'image' };

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('composer drafts', () => {
  it('keeps unsent text and attachments per session across a restart', async () => {
    let drafts = await loadDrafts();
    drafts.saveComposerDraft('s_a', { text: 'half a thought', attachments: [shot] });
    drafts.saveComposerDraft('s_b', { text: 'other chat', attachments: [] });
    drafts = await loadDrafts(true);
    expect(drafts.loadComposerDraft('s_a')).toEqual({ text: 'half a thought', attachments: [shot] });
    expect(drafts.loadComposerDraft('s_b').text).toBe('other chat');
    expect(drafts.loadComposerDraft('s_new')).toEqual({ text: '', attachments: [] });
  });

  it('forgets a draft once it is sent', async () => {
    const drafts = await loadDrafts();
    drafts.saveComposerDraft('s_a', { text: 'send me', attachments: [] });
    drafts.saveComposerDraft('s_a', { text: '', attachments: [] });
    expect(drafts.loadComposerDraft('s_a').text).toBe('');
    expect(storage.get('agentdeck:composer-drafts')).toBe('{}');
  });

  it('drops the oldest drafts instead of growing without end', async () => {
    const drafts = await loadDrafts();
    const now = vi.spyOn(Date, 'now');
    for (let i = 0; i < 45; i++) {
      now.mockReturnValue(1000 + i);
      drafts.saveComposerDraft(`s_${i}`, { text: `draft ${i}`, attachments: [] });
    }
    now.mockRestore();
    expect(drafts.loadComposerDraft('s_0').text).toBe('');
    expect(drafts.loadComposerDraft('s_4').text).toBe('');
    expect(drafts.loadComposerDraft('s_5').text).toBe('draft 5');
    expect(drafts.loadComposerDraft('s_44').text).toBe('draft 44');
  });

  it('survives unreadable storage', async () => {
    storage = new Map([['agentdeck:composer-drafts', 'not json']]);
    const drafts = await loadDrafts(true);
    expect(drafts.loadComposerDraft('s_a')).toEqual({ text: '', attachments: [] });
  });
});

describe('photo downscaling', () => {
  it('leaves images within the limit alone', () => {
    expect(fitWithin(1080, 2400, MAX_EDGE)).toEqual({ width: 1080, height: 2400 });
    expect(fitWithin(MAX_EDGE, 100, MAX_EDGE)).toEqual({ width: MAX_EDGE, height: 100 });
  });

  it('scales the longer edge down to the limit and keeps the proportions', () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3000, 4000, 2000)).toEqual({ width: 1500, height: 2000 });
    expect(fitWithin(10_000, 3, 1000)).toEqual({ width: 1000, height: 1 });
  });

  it('names a re-encoded file after its new type', () => {
    expect(renameForType('IMG_1.PNG', 'image/jpeg')).toBe('IMG_1.jpg');
    expect(renameForType('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg');
    expect(renameForType('photo.jpg', 'image/jpeg')).toBe('photo.jpg');
    expect(renameForType('shot.webp', 'image/png')).toBe('shot.png');
    expect(renameForType('noext', 'image/jpeg')).toBe('noext.jpg');
  });
});

describe('attachment URLs', () => {
  it('finds project and path behind a signed attachment link', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.resetModules();
    const { parseAttachmentUrl } = await import('../src/util/attachments');
    expect(
      parseAttachmentUrl('/api/projects/__attachments__/files/raw?path=s_1%2Ff_9__shot%20one.png&token=abc.def'),
    ).toEqual({ projectId: '__attachments__', path: 's_1/f_9__shot one.png' });
    expect(parseAttachmentUrl('http://host:8787/api/projects/p_1/files/raw?path=uploads%2Ff_2__a.png&token=t')).toEqual({
      projectId: 'p_1',
      path: 'uploads/f_2__a.png',
    });
    expect(parseAttachmentUrl('/api/projects/p_1/files/raw?token=t')).toBeNull();
    expect(parseAttachmentUrl('blob:https://localhost/1234')).toBeNull();
  });
});
