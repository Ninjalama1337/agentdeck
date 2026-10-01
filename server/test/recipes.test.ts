import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentId } from '@agentdeck/shared';
import {
  adminCapabilities,
  recipeFor,
  resolveRepoScript,
} from '../src/admin/recipes.js';
import { HttpError } from '../src/http/errors.js';
import { expandHome } from '../src/util/paths.js';

const AGENTS: AgentId[] = ['claude', 'zcode', 'antigravity', 'codex', 'opencode'];

describe('adminCapabilities', () => {
  it('exposes update/install/login for every agent', () => {
    for (const agentId of AGENTS) {
      const caps = adminCapabilities(agentId);
      expect(caps.map((c) => c.kind)).toEqual(['update', 'install', 'login']);
      for (const cap of caps) expect(cap.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('every agent exposes all three actions (logins included, none blocked)', () => {
    for (const agentId of AGENTS) {
      const caps = adminCapabilities(agentId);
      expect(caps.map((c) => c.kind)).toEqual(['update', 'install', 'login']);
      for (const cap of caps) {
        expect(cap.unavailableReason).toBeUndefined();
      }
    }
  });

  it('claude login uses the headless setup-token flow', () => {
    const recipe = recipeFor('claude', 'login');
    expect(recipe.command).toBe('claude');
    expect(recipe.args).toEqual(['setup-token']);
  });

  it('antigravity login launches the IDE detached (sh fire & forget)', () => {
    const recipe = recipeFor('antigravity', 'login');
    expect(recipe.command).toBe('sh');
    expect(recipe.args[0]).toBe('-c');
    expect(recipe.args[1]).toContain('flatpak run com.google.Antigravity');
  });
});

describe('recipeFor', () => {
  it('claude update runs `claude update` from the home dir', () => {
    const recipe = recipeFor('claude', 'update');
    expect(recipe).toMatchObject({ command: 'claude', args: ['update'], cwd: os.homedir() });
  });

  it('claude install installs the npm package globally', () => {
    const recipe = recipeFor('claude', 'install');
    expect(recipe.command).toBe('npm');
    expect(recipe.args).toEqual(['install', '-g', '@anthropic-ai/claude-code']);
  });

  it('zcode update + install resolve to the update script that exists in the repo', () => {
    for (const kind of ['update', 'install'] as const) {
      const recipe = recipeFor('zcode', kind);
      expect(recipe.command.endsWith(path.join('scripts', 'update-zcode.sh'))).toBe(true);
      expect(fs.existsSync(recipe.command)).toBe(true);
      expect(fs.statSync(recipe.command).isFile()).toBe(true);
      expect(recipe.args).toEqual([]);
      // cwd = repo root (two levels above scripts/)
      expect(recipe.cwd).toBe(path.dirname(path.dirname(recipe.command)));
      // node-24 prepended so the script finds its toolchain
      const nodeDir = expandHome('~/.local/opt/node-24/bin');
      expect(recipe.envAdd?.PATH.startsWith(`${nodeDir}:`)).toBe(true);
    }
  });

  it('zcode login runs `zcode login zai` with ~/.local/bin prepended', () => {
    const recipe = recipeFor('zcode', 'login');
    expect(recipe).toMatchObject({ command: 'zcode', args: ['login', 'zai'], cwd: os.homedir() });
    expect(recipe.envAdd?.PATH.startsWith(`${expandHome('~/.local/bin')}:`)).toBe(true);
  });

  it('zcode update script resolution works from src and dist layouts', () => {
    // resolveRepoScript mirrors findWebDist: whichever layout exists wins.
    const resolved = resolveRepoScript('update-zcode.sh');
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it('antigravity update/install drive flatpak', () => {
    expect(recipeFor('antigravity', 'update').args).toEqual(['update', '-y', 'com.google.Antigravity']);
    expect(recipeFor('antigravity', 'install').args).toEqual(['install', '-y', 'flathub', 'com.google.Antigravity']);
    expect(recipeFor('antigravity', 'update').command).toBe('flatpak');
  });

  it('codex update/install + login have the documented shapes', () => {
    const update = recipeFor('codex', 'update');
    expect(update.command).toBe('npm');
    expect(update.args).toEqual(['install', '-g', '@openai/codex@latest']);
    expect(recipeFor('codex', 'install').args).toEqual(update.args);
    expect(recipeFor('codex', 'login')).toMatchObject({ command: 'codex', args: ['login'], cwd: os.homedir() });
  });

  it('returns the login recipe for claude (no longer unavailable)', () => {
    const recipe = recipeFor('claude', 'login');
    expect(recipe.kind).toBe('login');
    expect(recipe.command).toBe('claude');
  });

  it('throws 404 for an unknown agent', () => {
    try {
      recipeFor('bogus' as AgentId, 'update');
      expect.unreachable('recipeFor should have thrown');
    } catch (err) {
      expect((err as HttpError).statusCode).toBe(404);
    }
  });
});
