/**
 * GitHub integration via the `gh` CLI (already authenticated on this machine).
 */
import { execa } from 'execa';
import type { GithubItem, GithubItemDetail, GithubRepo } from '@agentdeck/shared';
import { httpError } from '../http/errors.js';
import { withTimeoutFallback } from '../util/async.js';

export async function ghAuthStatus(): Promise<void> {
  try {
    const res = await withTimeoutFallback(execa('gh', ['auth', 'status'], { reject: false }), 10_000, null, 'gh auth status');
    if (!res) {
      throw httpError(503, 'GH_UNAVAILABLE', 'gh CLI did not respond — is GitHub CLI installed?');
    }
    if (res.exitCode !== 0) {
      throw httpError(503, 'GH_NOT_AUTHENTICATED', `gh is not authenticated: run \`gh auth login\` on the server (${(res.stderr || '').trim().slice(0, 200)})`);
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'statusCode' in err) throw err;
    throw httpError(503, 'GH_UNAVAILABLE', 'gh CLI not found — install GitHub CLI to browse repositories.');
  }
}

interface GhRepoJson {
  nameWithOwner?: string;
  url?: string;
  description?: string | null;
  updatedAt?: string;
  isPrivate?: boolean;
  primaryLanguage?: { name?: string } | null;
}

export async function listGithubRepos(limit = 20, q?: string): Promise<GithubRepo[]> {
  await ghAuthStatus();
  const bounded = Math.min(Math.max(limit, 1), 100);
  const res = await execa(
    'gh',
    [
      'repo',
      'list',
      '--limit',
      String(bounded),
      '--json',
      'nameWithOwner,url,description,updatedAt,isPrivate,primaryLanguage',
    ],
    { reject: false, timeout: 30_000 },
  );
  if (res.exitCode !== 0) {
    throw httpError(502, 'GH_ERROR', `gh repo list failed: ${(res.stderr || 'unknown error').trim().slice(0, 500)}`);
  }
  let parsed: GhRepoJson[];
  try {
    parsed = JSON.parse(res.stdout) as GhRepoJson[];
  } catch {
    throw httpError(502, 'GH_ERROR', 'gh returned unexpected output');
  }
  const repos: GithubRepo[] = [];
  for (const item of parsed) {
    if (!item.nameWithOwner) continue;
    repos.push({
      nameWithOwner: item.nameWithOwner,
      url: item.url ?? `https://github.com/${item.nameWithOwner}`,
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
      ...(item.isPrivate !== undefined ? { isPrivate: item.isPrivate } : {}),
      ...(item.primaryLanguage !== undefined ? { language: item.primaryLanguage?.name ?? null } : {}),
    });
  }
  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    return repos.filter((r) => r.nameWithOwner.toLowerCase().includes(needle));
  }
  return repos;
}

// ---------------------------------------------------------------------------
// Issues and pull requests of a project's repo (after Orca's GitHub view)
// ---------------------------------------------------------------------------

interface GhItemJson {
  number?: number;
  title?: string;
  url?: string;
  author?: { login?: string } | null;
  labels?: { name?: string }[];
  updatedAt?: string;
  comments?: unknown;
  headRefName?: string;
  isDraft?: boolean;
  body?: string;
}

async function ghJson<T>(cwd: string, args: string[]): Promise<T> {
  await ghAuthStatus();
  const res = await execa('gh', args, { cwd, reject: false, timeout: 30_000 });
  if (res.exitCode !== 0) {
    const msg = (res.stderr || res.stdout || 'unknown error').trim();
    if (/no git remotes|not a git repository|could not determine/i.test(msg)) {
      throw httpError(400, 'NO_GITHUB_REMOTE', 'This project has no GitHub remote.');
    }
    throw httpError(502, 'GH_ERROR', `gh ${args[0]} ${args[1]} failed: ${msg.slice(0, 400)}`);
  }
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    throw httpError(502, 'GH_ERROR', 'gh returned unexpected output');
  }
}

export function toGithubItem(kind: 'issue' | 'pr', j: GhItemJson): GithubItem | null {
  if (typeof j.number !== 'number' || !j.title || !j.url) return null;
  return {
    kind,
    number: j.number,
    title: j.title,
    url: j.url,
    ...(j.author?.login ? { author: j.author.login } : {}),
    labels: (j.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
    ...(j.updatedAt ? { updatedAt: j.updatedAt } : {}),
    ...(Array.isArray(j.comments) ? { comments: j.comments.length } : typeof j.comments === 'number' ? { comments: j.comments } : {}),
    ...(j.headRefName ? { headRef: j.headRefName } : {}),
    ...(typeof j.isDraft === 'boolean' ? { draft: j.isDraft } : {}),
  };
}

/** Open issues and pull requests, newest activity first. */
export async function listGithubItems(projectPath: string): Promise<GithubItem[]> {
  const [issues, prs] = await Promise.all([
    ghJson<GhItemJson[]>(projectPath, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url,author,labels,updatedAt,comments']),
    ghJson<GhItemJson[]>(projectPath, ['pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,url,author,labels,updatedAt,headRefName,isDraft']),
  ]);
  const items = [
    ...prs.map((j) => toGithubItem('pr', j)),
    ...issues.map((j) => toGithubItem('issue', j)),
  ].filter((i): i is GithubItem => i !== null);
  return items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export async function githubItemDetail(projectPath: string, kind: 'issue' | 'pr', number: number): Promise<GithubItemDetail> {
  const j = await ghJson<GhItemJson & { comments?: { author?: { login?: string }; body?: string; createdAt?: string }[] }>(projectPath, [
    kind,
    'view',
    String(number),
    '--json',
    kind === 'pr' ? 'number,title,url,author,labels,updatedAt,headRefName,isDraft,body,comments' : 'number,title,url,author,labels,updatedAt,body,comments',
  ]);
  const item = toGithubItem(kind, j);
  if (!item) throw httpError(502, 'GH_ERROR', 'gh returned unexpected output');
  const thread = (Array.isArray(j.comments) ? j.comments : []).map((c) => ({
    ...(c.author?.login ? { author: c.author.login } : {}),
    body: c.body ?? '',
    ...(c.createdAt ? { createdAt: c.createdAt } : {}),
  }));
  return { ...item, body: j.body ?? '', thread };
}
