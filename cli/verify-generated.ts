#!/usr/bin/env bun
/**
 * The template's acceptance loop: generate a project from this checkout
 * and run every `bun check` stage in it except `policy` (which needs the
 * GitHub remote a `--no-github` project lacks).
 *
 *   bun cli/verify-generated.ts <slug> [--display "Name"] [--dir <dir>]
 *     [--stages lint,test] [--e2e] [--keep-going]
 *
 * `--e2e` (or `e2e` in `--stages`) adds the browser suite on a stack of its
 * own (cli/verify-e2e.ts).
 *
 * The target directory is deleted first. Each stage's output goes to
 * `<dir>.logs/<stage>.log`; a table of results is printed at the end and
 * the exit code is 1 when any stage failed. See cli/README.md.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultDisplay } from './rename';
import { runE2EStage } from './verify-e2e';
import { isPortFree } from './wizard-io';

/** `bun check` without `policy`, in its order. */
export const STAGES = [
  'format:check',
  'lint',
  'knip',
  'duplication',
  'invariants',
  'evidence',
  'typecheck',
  'test',
  'metrics:check',
  'build',
] as const;

/** Stages only run when asked for: `e2e` needs Docker and browsers. */
const OPTIONAL_STAGES = ['e2e'] as const;

export type VerifyOptions = {
  readonly slug: string;
  readonly display: string;
  readonly dir: string;
  readonly stages: readonly string[];
  readonly keepGoing: boolean;
};

/** The stages to run: `--stages` (default all of STAGES), then `e2e` once for `--e2e`. */
const selectStages = (
  listed: string | undefined,
  e2e: boolean,
): readonly string[] => {
  const chosen = listed
    ? listed.split(',').map((stage) => stage.trim())
    : [...STAGES];
  return e2e && !chosen.includes('e2e') ? [...chosen, 'e2e'] : chosen;
};

const VERIFY_USAGE = `Usage: bun cli/verify-generated.ts <slug> [--display "Name"] [--dir <dir>] [--stages a,b] [--e2e] [--keep-going]`;

/** Parses argv (without `bun cli/verify-generated.ts`). */
/**
 * Generated projects live under ~/.cache, never $TMPDIR: macOS purges
 * files in $TMPDIR that look old, and Bun copies package files from its
 * cache with their original timestamps, so an install there can lose files
 * while a long run (or a sleeping machine) waits.
 */
const DEFAULT_SCRATCH = join(homedir(), '.cache', 'init-offense-verify');

export function parseVerifyArgs(
  argv: readonly string[],
  scratch: string = DEFAULT_SCRATCH,
): VerifyOptions | { readonly error: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        display: { type: 'string' },
        dir: { type: 'string' },
        stages: { type: 'string' },
        e2e: { type: 'boolean', default: false },
        'keep-going': { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  const { values, positionals } = parsed;
  const [slug, ...extra] = positionals;
  if (!slug || extra.length > 0) return { error: VERIFY_USAGE };
  const stages = selectStages(values.stages, values.e2e);
  const known: readonly string[] = [...STAGES, ...OPTIONAL_STAGES];
  const unknown = stages.filter((stage) => !known.includes(stage));
  if (unknown.length > 0)
    return { error: `Unknown stage(s): ${unknown.join(', ')}` };
  return {
    slug,
    display: values.display ?? defaultDisplay(slug),
    dir: resolve(values.dir ?? join(scratch, `gen-${slug}`)),
    stages,
    keepGoing: values['keep-going'],
  };
}

export type StageResult = { readonly stage: string; readonly status: string };

/** A Markdown table of stage results, ready to paste into a report. */
export function formatResults(
  slug: string,
  results: readonly StageResult[],
): string {
  return [
    `| ${slug} | result |`,
    '| --- | --- |',
    ...results.map(({ stage, status }) => `| ${stage} | ${status} |`),
  ].join('\n');
}

const runLogged = (
  command: string,
  args: readonly string[],
  cwd: string,
  log: string,
  env: Record<string, string | undefined> = process.env,
): number => {
  const fd = openSync(log, 'w');
  try {
    return (
      spawnSync(command, [...args], { cwd, env, stdio: ['ignore', fd, fd] })
        .status ?? 1
    );
  } finally {
    closeSync(fd);
  }
};

const runStage = (
  stage: string,
  options: VerifyOptions,
  logs: string,
  say: (line: string) => void,
): number =>
  stage === 'e2e'
    ? runE2EStage({
        dir: options.dir,
        slug: options.slug,
        logs,
        isPortFree,
        run: runLogged,
        say,
      })
    : runLogged('bun', ['run', stage], options.dir, join(logs, `${stage}.log`));

function verify(options: VerifyOptions): number {
  const logs = `${options.dir}.logs`;
  rmSync(options.dir, { recursive: true, force: true });
  rmSync(logs, { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  const say = (line: string) => process.stdout.write(`${line}\n`);
  say(`Generating ${options.slug} in ${options.dir} (logs: ${logs})`);
  const generated = runLogged(
    'bun',
    [
      join(import.meta.dir, 'init.ts'),
      'new',
      options.dir,
      '--name',
      options.slug,
      '--display',
      options.display,
      '--owner',
      '2witstudios',
      '--no-github',
      '--no-drive',
      '--yes',
    ],
    process.cwd(),
    join(logs, 'generate.log'),
  );
  const results: StageResult[] = [
    { stage: 'generate', status: generated === 0 ? 'pass' : 'FAIL' },
  ];
  for (const stage of generated === 0 ? options.stages : []) {
    const status = runStage(stage, options, logs, say);
    results.push({ stage, status: status === 0 ? 'pass' : 'FAIL' });
    say(`  ${stage}: ${status === 0 ? 'pass' : `FAIL (${stage}.log)`}`);
    if (status !== 0 && !options.keepGoing) break;
  }
  say(`\n${formatResults(options.slug, results)}`);
  const ran = results.length - 1 === options.stages.length;
  return ran && results.every(({ status }) => status === 'pass') ? 0 : 1;
}

if (import.meta.main) {
  const options = parseVerifyArgs(process.argv.slice(2));
  if ('error' in options) {
    process.stderr.write(`${options.error}\n`);
    process.exit(2);
  }
  process.exit(verify(options));
}
