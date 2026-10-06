/**
 * The real effects behind `WizardDeps`: child processes, the terminal
 * (node:readline, no dependencies), the browser, ports and files.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { openInBrowser } from '../scripts/browser';
import { consentFilter } from '../scripts/pagespace-consent';
import { isPortFree } from '../scripts/port-probe';
import {
  WizardStop,
  type Captured,
  type Choice,
  type Prompt,
  type RunOptions,
  type Runner,
  type Stopped,
  type WizardDeps,
} from './wizard-deps';

const PROBE_TIMEOUT_MS = 20_000;
/** How much of the dev server's output is kept to explain an early exit. */
const OUTPUT_TAIL_CHARS = 16_384;
/** How long output may keep draining after the dev server exits. */
const DRAIN_GRACE_MS = 2_000;

/** PATH with Bun's own directory and its global bin directory first. */
const childPath = (): string =>
  [
    dirname(process.execPath),
    join(homedir(), '.bun', 'bin'),
    process.env.PATH ?? '',
  ].join(delimiter);

const childEnv = (options: RunOptions = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: childPath(),
  ...options.env,
});

const output = (stdout: string | null): string => stdout ?? '';

const runner: Runner = {
  probe: (command, options) => {
    const [file = '', ...args] = command;
    const result = spawnSync(file, args, {
      cwd: options?.cwd,
      env: childEnv(options),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });
    return { code: result.status ?? 127, stdout: output(result.stdout) };
  },
  run: (command, options) => {
    const [file = '', ...args] = command;
    return (
      spawnSync(file, args, {
        cwd: options?.cwd,
        env: childEnv(options),
        stdio: 'inherit',
      }).status ?? 1
    );
  },
  consent: (command, options) =>
    new Promise<Captured>((resolve) => {
      const [file = '', ...args] = command;
      const child = spawn(file, args, {
        cwd: options?.cwd,
        env: childEnv(options),
        stdio: ['inherit', 'pipe', 'pipe'],
      });
      const filter = consentFilter((line) => process.stderr.write(`${line}\n`));
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', filter.push);
      const finish = (code: number) => {
        filter.end(code);
        resolve({ code, stdout });
      };
      child.on('error', () => finish(127));
      child.on('close', (code) => finish(code ?? 1));
    }),
  start: (command, options) =>
    new Promise<Stopped>((resolve) => {
      const [file = '', ...args] = command;
      const child = spawn(file, args, {
        cwd: options?.cwd,
        env: childEnv({
          ...options,
          env: { FORCE_COLOR: '1', ...options?.env },
        }),
        stdio: ['inherit', 'pipe', 'pipe'],
      });
      let output = '';
      const keep = (into: NodeJS.WriteStream) => (chunk: string) => {
        into.write(chunk);
        output = (output + chunk).slice(-OUTPUT_TAIL_CHARS);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', keep(process.stdout));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', keep(process.stderr));
      const finish = (code: number | null) =>
        resolve({ code: code ?? 130, output });
      child.on('error', () => finish(127));
      child.on('close', finish);
      // 'close' waits for the pipes to drain; a grandchild still holding
      // them must not keep the wizard waiting after the dev server exits.
      child.on('exit', (code) =>
        setTimeout(() => finish(code), DRAIN_GRACE_MS).unref(),
      );
    }),
};

const cancelled = () =>
  new WizardStop('\nCancelled. Nothing else was changed.', 130);

/** One line of input; Ctrl-C or Ctrl-D cancels the wizard. */
function ask(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let answered = false;
    rl.on('SIGINT', () => rl.close());
    rl.on('close', () => {
      if (!answered) reject(cancelled());
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

const say = (line: string) => process.stdout.write(`${line}\n`);

const ttyPrompt: Prompt = {
  text: async (question, fallback, validate) => {
    for (;;) {
      const answer =
        (await ask(`${question}${fallback ? ` (${fallback})` : ''}: `)) ||
        fallback;
      const problem =
        answer === '' ? 'needs an answer' : (validate?.(answer) ?? null);
      if (!problem) return answer;
      say(`  That ${problem}. Try again.`);
    }
  },
  confirm: async (question, fallback) => {
    for (;;) {
      const answer = (
        await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)
      ).toLowerCase();
      if (answer === '') return fallback;
      if (YES.has(answer)) return true;
      if (NO.has(answer)) return false;
      say('  Please answer y or n.');
    }
  },
  select: async <T extends string>(
    question: string,
    choices: readonly Choice<T>[],
    fallback: T,
  ) => {
    say(question);
    choices.forEach((choice, index) => say(`  ${index + 1}. ${choice.label}`));
    const fallbackIndex =
      choices.findIndex((choice) => choice.value === fallback) + 1;
    for (;;) {
      const answer = await ask(
        `Choose 1-${choices.length} (${fallbackIndex}): `,
      );
      const picked =
        answer === ''
          ? choices[fallbackIndex - 1]
          : choices[Number(answer) - 1];
      if (picked) return picked.value;
      say(`  Please type a number from 1 to ${choices.length}.`);
    }
  },
  pause: async (message) => {
    await ask(`${message} `);
  },
};

const noTerminal = (question: string): never => {
  throw new WizardStop(
    `This step asks "${question}", but there is no terminal to answer in. ` +
      'Re-run with --yes (and --name <slug>) to accept the defaults, or pass the answer as a flag.',
    2,
  );
};

const headlessPrompt: Prompt = {
  text: async (question) => noTerminal(question),
  confirm: async (question) => noTerminal(question),
  select: async (question) => noTerminal(question),
  pause: async (message) => noTerminal(message),
};

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

function open(url: string): void {
  openInBrowser(url);
  say(`  (opened ${url})`);
}

export function realDeps(templateRoot: string): WizardDeps {
  const pinned = join(templateRoot, '.bun-version');
  return {
    runner,
    prompt: process.stdin.isTTY ? ttyPrompt : headlessPrompt,
    open,
    log: say,
    platform: process.platform,
    cwd: process.cwd(),
    isPortFree,
    sleep: (ms) => Bun.sleep(ms),
    holdInterrupts: () => {
      let interrupted = false;
      const hold = () => {
        interrupted = true;
      };
      process.on('SIGINT', hold);
      return () => {
        process.off('SIGINT', hold);
        return interrupted;
      };
    },
    reachable,
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    writeFile: (path, text) => writeFileSync(path, text),
    bunVersion: Bun.version,
    pinnedBunVersion: existsSync(pinned)
      ? readFileSync(pinned, 'utf8').trim()
      : null,
  };
}
