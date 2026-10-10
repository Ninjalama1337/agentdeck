import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { CliError } from '../src/cli/exec.js';

describe('agentdeck-server command line', () => {
  it('no arguments run the server', () => {
    expect(parseArgs([])).toEqual({ kind: 'serve' });
  });

  it('knows help and version', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
  });

  it('parses info', () => {
    expect(parseArgs(['info'])).toEqual({ kind: 'info', json: false });
    expect(parseArgs(['info', '--json'])).toEqual({ kind: 'info', json: true });
  });

  it('parses the service actions', () => {
    for (const action of ['status', 'start', 'stop', 'restart'] as const) {
      expect(parseArgs(['service', action])).toEqual({ kind: 'service', action, json: false });
      expect(parseArgs(['service', action, '--json'])).toEqual({ kind: 'service', action, json: true });
    }
    expect(parseArgs(['service', 'uninstall', '--force'])).toEqual({ kind: 'service', action: 'uninstall', json: false, force: true });
  });

  it('parses service install with its options', () => {
    expect(parseArgs(['service', 'install'])).toEqual({
      kind: 'service',
      action: 'install',
      json: false,
      lan: false,
      start: true,
      force: false,
    });
    expect(parseArgs(['service', 'install', '--lan', '--port', '9000', '--no-start', '--force', '--json'])).toEqual({
      kind: 'service',
      action: 'install',
      json: true,
      lan: true,
      port: 9000,
      start: false,
      force: true,
    });
    expect(parseArgs(['service', 'install', '--port=8800'])).toMatchObject({ port: 8800 });
  });

  it('rejects what it does not understand with exit code 2', () => {
    const bad = (argv: string[]): CliError => {
      try {
        parseArgs(argv);
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        return err as CliError;
      }
      throw new Error(`expected ${argv.join(' ')} to be rejected`);
    };
    expect(bad(['frobnicate']).exitCode).toBe(2);
    expect(bad(['service']).message).toMatch(/needs an action/);
    expect(bad(['service', 'explode']).message).toMatch(/Unknown service action/);
    expect(bad(['service', 'install', '--port']).message).toMatch(/--port needs/);
    expect(bad(['service', 'install', '--port', '70000']).message).toMatch(/--port needs/);
    expect(bad(['service', 'install', '--port=abc']).message).toMatch(/--port needs/);
    // options belong to their command
    expect(bad(['service', 'start', '--lan']).message).toMatch(/Unknown option/);
    expect(bad(['info', '--force']).message).toMatch(/Unknown option/);
    expect(bad(['info', 'extra']).message).toMatch(/Unknown argument/);
  });
});
