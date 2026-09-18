#!/usr/bin/env node

import { constants, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, unlink } from 'node:fs/promises';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { main } from './server.js';

const HELP = `Usage:
  codex-llama.cpp-bridge [config.json]
  codex-llama.cpp-bridge --init [directory]
  codex-llama.cpp-bridge --help
  codex-llama.cpp-bridge --version

If config.json is omitted, CODEX_LLAMA_CPP_BRIDGE_CONFIG is used. Without
either, the bridge listens on 127.0.0.1:10901 and forwards to
http://qwen.local:5656/v1.`;

function packageRoot(): URL {
  return new URL('../', import.meta.url);
}

async function packageVersion(): Promise<string> {
  const contents = await readFile(new URL('package.json', packageRoot()), 'utf8');
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { version?: unknown }).version !== 'string') {
    throw new Error('package.json does not contain a version');
  }
  return (value as { version: string }).version;
}

async function initializeExamples(directory: string): Promise<void> {
  const destination = path.resolve(directory);
  await mkdir(destination, { recursive: true });
  const examples = [
    ['bridge.config.json', 'bridge.config.json'],
    ['codex.config.toml', 'codex.config.toml'],
  ] as const;
  const created: string[] = [];
  try {
    for (const [source, target] of examples) {
      const targetPath = path.join(destination, target);
      await copyFile(new URL(`examples/${source}`, packageRoot()), targetPath, constants.COPYFILE_EXCL);
      created.push(targetPath);
    }
  } catch (error) {
    await Promise.all(created.map((target) => unlink(target)));
    throw error;
  }
  console.log(`Created ${path.join(destination, 'bridge.config.json')}`);
  console.log(`Created ${path.join(destination, 'codex.config.toml')}`);
}

export async function runCli(args: readonly string[]): Promise<Server | undefined> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(await packageVersion());
    return;
  }

  const initIndex = args.indexOf('--init');
  if (initIndex >= 0) {
    if (args.length > initIndex + 2 || args.slice(0, initIndex).length > 0) {
      throw new Error('--init accepts only an optional destination directory');
    }
    const directory = args[initIndex + 1] ?? '.';
    if (directory.startsWith('-')) throw new Error('--init destination must not be an option');
    await initializeExamples(directory);
    return;
  }
  if (args.some((argument) => argument.startsWith('-'))) {
    throw new Error(`unknown option: ${args.find((argument) => argument.startsWith('-')) ?? ''}`);
  }
  if (args.length > 1) throw new Error('expected at most one config path');
  return main(args[0]);
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export async function runCliMain(args = process.argv.slice(2)): Promise<void> {
  try {
    await runCli(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  void runCliMain();
}
