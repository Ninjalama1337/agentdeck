import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudePaths, markClaudeOnboarded } from '../src/admin/claudeOnboarding.js';

let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-onboarding-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function signIn(paths = claudePaths({}, home)) {
  fs.mkdirSync(path.dirname(paths.credentials), { recursive: true });
  fs.writeFileSync(paths.credentials, '{}');
  return paths;
}

describe('claudePaths', () => {
  it('uses ~/.claude.json and ~/.claude/.credentials.json by default', () => {
    expect(claudePaths({}, home)).toEqual({
      config: path.join(home, '.claude.json'),
      credentials: path.join(home, '.claude', '.credentials.json'),
    });
  });

  it('follows CLAUDE_CONFIG_DIR', () => {
    expect(claudePaths({ CLAUDE_CONFIG_DIR: '/x/claude-work' }, home)).toEqual({
      config: '/x/claude-work/.claude.json',
      credentials: '/x/claude-work/.credentials.json',
    });
  });
});

describe('markClaudeOnboarded', () => {
  it('does nothing without a stored sign-in', () => {
    const paths = claudePaths({}, home);
    expect(markClaudeOnboarded(paths)).toBe(false);
    expect(fs.existsSync(paths.config)).toBe(false);
  });

  it('creates the config when it is missing', () => {
    const paths = signIn();
    expect(markClaudeOnboarded(paths)).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8'))).toEqual({ hasCompletedOnboarding: true });
  });

  it('sets the flag and keeps every other setting and the file mode', () => {
    const paths = signIn();
    fs.writeFileSync(paths.config, JSON.stringify({ theme: 'light', projects: { '/a': { x: 1 } } }), { mode: 0o600 });
    expect(markClaudeOnboarded(paths)).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8'))).toEqual({
      theme: 'light',
      projects: { '/a': { x: 1 } },
      hasCompletedOnboarding: true,
    });
    expect(fs.statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves a config alone that already has the flag', () => {
    const paths = signIn();
    const before = JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' });
    fs.writeFileSync(paths.config, before);
    expect(markClaudeOnboarded(paths)).toBe(false);
    expect(fs.readFileSync(paths.config, 'utf8')).toBe(before);
  });

  it('throws on unreadable JSON and does not touch the file', () => {
    const paths = signIn();
    fs.writeFileSync(paths.config, '{ broken');
    expect(() => markClaudeOnboarded(paths)).toThrow();
    expect(fs.readFileSync(paths.config, 'utf8')).toBe('{ broken');
  });
});
