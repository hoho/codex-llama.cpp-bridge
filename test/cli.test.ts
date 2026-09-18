import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMainModule, runCli, runCliMain } from '../src/cli.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI', () => {
  it('prints help and package version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runCli(['--help'])).resolves.toBeUndefined();
    expect(log.mock.calls.flat().join('\n')).toContain('Usage:');
    log.mockClear();

    await expect(runCli(['-v'])).resolves.toBeUndefined();
    const manifest: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || typeof manifest.version !== 'string') {
      throw new Error('Expected a package version');
    }
    expect(log).toHaveBeenCalledWith(manifest.version);
  });

  it('rejects invalid argument combinations', async () => {
    await expect(runCli(['--unknown'])).rejects.toThrow('unknown option: --unknown');
    await expect(runCli(['one.json', 'two.json'])).rejects.toThrow('expected at most one config path');
    await expect(runCli(['before', '--init'])).rejects.toThrow('--init accepts only an optional destination directory');
    await expect(runCli(['--init', 'directory', 'extra'])).rejects.toThrow('--init accepts only an optional destination directory');
    await expect(runCli(['--init', '--destination'])).rejects.toThrow('--init destination must not be an option');
  });

  it('detects direct execution and reports CLI failures', async () => {
    const sourceUrl = new URL('../src/cli.ts', import.meta.url);
    expect(isMainModule(undefined, sourceUrl.href)).toBe(false);
    expect(isMainModule('/missing/codex-llama.cpp-bridge', sourceUrl.href)).toBe(false);
    expect(isMainModule(fileURLToPath(sourceUrl), sourceUrl.href)).toBe(true);

    const previousExitCode = process.exitCode;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
    try {
      await runCliMain(['--unknown']);
      expect(error).toHaveBeenCalledWith('unknown option: --unknown');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('rolls back files created before an initialization conflict', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-llama-cli-conflict-'));
    const existingConfig = path.join(directory, 'codex.config.toml');
    await writeFile(existingConfig, 'keep me');
    try {
      await expect(runCli(['--init', directory])).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(access(path.join(directory, 'bridge.config.json'), constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(existingConfig, 'utf8')).resolves.toBe('keep me');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('starts the bridge from an explicit config path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-llama-cli-server-'));
    const configPath = path.join(directory, 'bridge.config.json');
    await writeFile(configPath, JSON.stringify({ listen: { host: '127.0.0.1', port: 0 }, upstream: 'http://llama.invalid/v1' }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const server = await runCli([configPath]);
      expect(server).toBeDefined();
      if (!server) throw new Error('bridge server did not start');
      const port = (server.address() as AddressInfo).port;
      expect(port).toBeGreaterThan(0);
      expect(error).toHaveBeenCalledWith(`codex-llama.cpp-bridge listening on http://127.0.0.1:${String(port)}/v1`);
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) => {
          if (closeError) reject(closeError);
          else resolve();
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
