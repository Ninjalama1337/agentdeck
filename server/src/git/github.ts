/**
 * GitHub integration via the `gh` CLI (already authenticated on this machine).
 */
import { execa } from 'execa';
import type { GithubRepo } from '@agentdeck/shared';
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
