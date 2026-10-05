#!/usr/bin/env bun
/**
 * The template's acceptance loop: generate a project from this checkout
 * and run every `bun check` stage in it except `policy` (which needs the
 * GitHub remote a `--no-github` project lacks).
 *
 *   bun cli/verify-generated.ts <slug> [--display "Name"] [--dir <dir>]
 *     [--stages lint,test] [--keep-going]
 *
 * The target directory is deleted first. Each stage's output goes to
 * `<dir>.logs/<stage>.log`; a table of results is printed at the end and
 * the exit code is 1 when any stage failed. See cli/README.md.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultDisplay } from './rename';

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

export type VerifyOptions = {
  readonly slug: string;
  readonly display: string;
  readonly dir: string;
  readonly stages: readonly string[];
  readonly keepGoing: boolean;
};

const VERIFY_USAGE = `Usage: bun cli/verify-generated.ts <slug> [--display "Name"] [--dir <dir>] [--stages a,b] [--keep-going]`;

/** Parses argv (without `bun cli/verify-generated.ts`). */
export function parseVerifyArgs(
  argv: readonly string[],
  scratch: string = tmpdir(),
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
        'keep-going': { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  const { values, positionals } = parsed;
  const [slug, ...extra] = positionals;
  if (!slug || extra.length > 0) return { error: VERIFY_USAGE };
  const stages = values.stages
    ? values.stages.split(',').map((stage) => stage.trim())
    : [...STAGES];
  const unknown = stages.filter(
    (stage) => !(STAGES as readonly string[]).includes(stage),
  );
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
): number => {
  const fd = openSync(log, 'w');
  try {
    return (
      spawnSync(command, [...args], { cwd, stdio: ['ignore', fd, fd] })
        .status ?? 1
    );
  } finally {
    closeSync(fd);
  }
};

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
    const status = runLogged(
      'bun',
      ['run', stage],
      options.dir,
      join(logs, `${stage}.log`),
    );
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
