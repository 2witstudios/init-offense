#!/usr/bin/env node
/**
 * `npx create-init-offense my-app` / `bunx create-init-offense my-app` /
 * `npm create init-offense my-app`. The real effects behind lib/create.js.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { main } from '../lib/create.js';

const run = (command, args, options, stdio = 'inherit') =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio,
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    child.on('error', () => resolve(127));
    child.on('exit', (code) => resolve(code ?? 130));
  });

const confirm = (question) =>
  new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${question} [Y/n] `, (answer) => {
      rl.close();
      resolve(!/^n(o)?$/i.test(answer.trim()));
    });
    rl.on('SIGINT', () => {
      rl.close();
      resolve(false);
    });
  });

const ignore = () => {};

const deps = {
  platform: process.platform,
  env: process.env,
  home: homedir(),
  cwd: process.cwd(),
  log: (line) => process.stdout.write(`${line}\n`),
  probe: (command, args) => run(command, args, {}, 'ignore'),
  run,
  confirm,
  exists: existsSync,
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  makeTempDir: () => mkdtempSync(join(tmpdir(), 'init-offense-')),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  holdInterrupts: () => {
    process.on('SIGINT', ignore);
    return () => process.off('SIGINT', ignore);
  },
};

process.exitCode = await main(process.argv.slice(2), deps);
