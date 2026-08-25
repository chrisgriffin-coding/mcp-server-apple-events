#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const requiredFiles = {
  server: 'dist/index.js',
  mcpSdk: 'node_modules/@modelcontextprotocol/sdk/package.json',
  exitOnEpipe: 'node_modules/exit-on-epipe/package.json',
  zod: 'node_modules/zod/package.json',
  readHelper: 'bin/eventkit-read-helper',
  readHelperHash: 'bin/eventkit-read-helper.sha256',
  readShim: 'bin/eventkit-read-helper-disclaim',
  readShimHash: 'bin/eventkit-read-helper-disclaim.sha256',
  createHelper: 'bin/eventkit-calendar-create-helper',
  createHelperHash: 'bin/eventkit-calendar-create-helper.sha256',
  createShim: 'bin/eventkit-calendar-create-helper-disclaim',
  createShimHash: 'bin/eventkit-calendar-create-helper-disclaim.sha256',
};

function absolute(relativePath) {
  return path.join(pluginRoot, relativePath);
}

function requireRegularFile(relativePath) {
  let stats;
  try {
    stats = statSync(absolute(relativePath), { throwIfNoEntry: false });
  } catch (error) {
    throw new Error(`Cannot inspect ${relativePath}: ${error.message}`);
  }
  if (!stats?.isFile()) {
    throw new Error(`Required plugin file is missing: ${relativePath}`);
  }
}

function readHash(relativePath) {
  const value = readFileSync(absolute(relativePath), 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid SHA-256 value in ${relativePath}`);
  }
  return value;
}

function fail(error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `Apple EventKit plugin could not start: ${detail}\n` +
      'Prepare the plugin source with the reviewed commands in README.md, then reinstall it so Codex snapshots the built files.\n',
  );
  process.exitCode = 1;
}

try {
  if (process.platform !== 'darwin') {
    throw new Error('EventKit is available only on macOS.');
  }

  for (const relativePath of Object.values(requiredFiles)) {
    requireRegularFile(relativePath);
  }

  const child = spawn(process.execPath, [absolute(requiredFiles.server)], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      EVENTKIT_HELPER_SHA256: readHash(requiredFiles.readHelperHash),
      EVENTKIT_DISCLAIM_SHA256: readHash(requiredFiles.readShimHash),
      EVENTKIT_CREATE_HELPER_SHA256: readHash(requiredFiles.createHelperHash),
      EVENTKIT_CREATE_DISCLAIM_SHA256: readHash(requiredFiles.createShimHash),
    },
    stdio: 'inherit',
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.once('error', fail);
  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
} catch (error) {
  fail(error);
}
