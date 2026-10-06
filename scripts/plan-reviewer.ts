/**
 * The pure half of `bun plan:review`: which reviewer CLI runs, with which
 * model, and the exact read-only command line for it. Every runner gets the
 * same prompt on stdin; only the command differs. Precedence for the
 * runner, model and effort is flag > env > project.config.json > default.
 */
import {
  PLAN_REVIEW_EFFORT,
  PLAN_REVIEW_MODEL,
  PLAN_REVIEW_RUNNER_RULE,
  PLAN_REVIEW_RUNNERS,
  isPlanReviewRunner,
  type PlanReviewConfig,
  type PlanReviewRunner,
} from './project-config';

export type PlanSource =
  | { readonly kind: 'page'; readonly id: string }
  | { readonly kind: 'file'; readonly path: string };

/** One layer of reviewer settings, before validation. */
export type ReviewerLayer = {
  readonly runner?: string;
  readonly model?: string;
  readonly effort?: string;
};

type PlanReviewArgs = ReviewerLayer & { readonly source: PlanSource };

export const PLAN_REVIEW_USAGE =
  'usage: bun plan:review <planPageId> | --plan-file <path> [--runner codex|claude|opencode] [--model <model>] [--effort <level>]';

const PAGE_ID = /^[a-z0-9]{20,32}$/;
const VALUE_FLAGS = ['--plan-file', '--runner', '--model', '--effort'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

type Flags = {
  readonly values: Partial<Record<ValueFlag, string>>;
  readonly positional: readonly string[];
};

const readFlags = (argv: readonly string[]): Flags | { error: string } => {
  const values: Partial<Record<ValueFlag, string>> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split(/=(.*)/s, 2);
    if (!flag.startsWith('--')) {
      positional.push(argv[index]);
      continue;
    }
    if (!VALUE_FLAGS.includes(flag as ValueFlag))
      return { error: `unknown option ${flag}` };
    const value = inline ?? argv[(index += 1)];
    if (value === undefined || value === '')
      return { error: `${flag} needs a value` };
    values[flag as ValueFlag] = value;
  }
  return { values, positional };
};

const planSource = (
  file: string | undefined,
  positional: readonly string[],
): PlanSource | { error: string } => {
  if (positional.length > 1) return { error: 'expected one plan page id' };
  if (file !== undefined && positional.length > 0)
    return { error: 'pass a plan page id or --plan-file, not both' };
  if (file !== undefined) return { kind: 'file', path: file };
  const [id] = positional;
  return id !== undefined && PAGE_ID.test(id)
    ? { kind: 'page', id }
    : { error: 'expected a plan page id or --plan-file <path>' };
};

/** Parses the command line; a usage error comes back as `{ error }`. */
export function parsePlanReviewArgs(
  argv: readonly string[],
): PlanReviewArgs | { readonly error: string } {
  const flags = readFlags(argv);
  if ('error' in flags) return flags;
  const { values } = flags;
  const source = planSource(values['--plan-file'], flags.positional);
  if ('error' in source) return source;
  return {
    source,
    ...(values['--runner'] !== undefined && { runner: values['--runner'] }),
    ...(values['--model'] !== undefined && { model: values['--model'] }),
    ...(values['--effort'] !== undefined && { effort: values['--effort'] }),
  };
}

const runnerOf = (
  value: string | undefined,
  source: string,
): PlanReviewRunner | undefined => {
  if (value === undefined || isPlanReviewRunner(value)) return value;
  throw new Error(`${source} ${PLAN_REVIEW_RUNNER_RULE}`);
};

const checked = (
  value: string | undefined,
  source: string,
  pattern: RegExp,
): string | undefined => {
  if (value === undefined) return undefined;
  if (!pattern.test(value)) throw new Error(`${source} must match ${pattern}`);
  return value;
};

/** The reviewer settings in the environment; an empty variable counts as unset. */
export const envLayer = (
  env: Readonly<Record<string, string | undefined>>,
): ReviewerLayer => {
  const read = (name: string) => (env[name] === '' ? undefined : env[name]);
  return {
    runner: read('PLAN_REVIEW_RUNNER'),
    model: read('PLAN_REVIEW_MODEL'),
    effort: read('PLAN_REVIEW_EFFORT'),
  };
};

/**
 * Resolves flag > env > config > default. A layer's model and effort apply
 * only when that layer names no runner or names the runner that won, so a
 * Codex model in the config never reaches `--runner claude`.
 */
export function resolveReviewer(input: {
  readonly flags: ReviewerLayer;
  readonly env: ReviewerLayer;
  readonly config: PlanReviewConfig;
}): PlanReviewConfig {
  const layers = [
    { name: 'flag', layer: input.flags },
    { name: 'env', layer: input.env },
  ].map(({ name, layer }) => ({
    runner: runnerOf(
      layer.runner,
      name === 'flag' ? '--runner' : 'PLAN_REVIEW_RUNNER',
    ),
    model: checked(
      layer.model,
      name === 'flag' ? '--model' : 'PLAN_REVIEW_MODEL',
      PLAN_REVIEW_MODEL,
    ),
    effort: checked(
      layer.effort,
      name === 'flag' ? '--effort' : 'PLAN_REVIEW_EFFORT',
      PLAN_REVIEW_EFFORT,
    ),
  }));
  const all = [...layers, input.config];
  const runner =
    all.find((layer) => layer.runner !== undefined)?.runner ?? 'codex';
  const applies = all.filter(
    (layer) => layer.runner === undefined || layer.runner === runner,
  );
  const model = applies.find((layer) => layer.model !== undefined)?.model;
  const effort = applies.find((layer) => layer.effort !== undefined)?.effort;
  return {
    runner,
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
  };
}

/** How to run one reviewer: argv, where the review lands and where it runs. */
export type ReviewerCommand = {
  readonly argv: readonly string[];
  /** `file`: the CLI writes its final message to `out`; `stdout`: captured. */
  readonly output: 'file' | 'stdout';
  /** `copy`: run in a throwaway copy of the repository, never the checkout. */
  readonly workspace: 'repo' | 'copy';
  readonly env: Readonly<Record<string, string>>;
};

/** Claude Code may only read: no Bash, no edits, no MCP servers, no prompts. */
const CLAUDE_TOOLS = 'Read,Grep,Glob';

/** OpenCode's permission override: deny every tool that can change anything. */
export const OPENCODE_PERMISSION = JSON.stringify({
  edit: 'deny',
  bash: 'deny',
  webfetch: 'deny',
  external_directory: 'deny',
});

const flag = (name: string, value: string | undefined): string[] =>
  value === undefined ? [] : [name, value];

/** The exact read-only command line for a reviewer. */
export function reviewerCommand(
  reviewer: PlanReviewConfig,
  paths: { readonly root: string; readonly out: string },
): ReviewerCommand {
  const { model, effort } = reviewer;
  switch (reviewer.runner) {
    case 'codex':
      return {
        argv: [
          'codex',
          'exec',
          '--sandbox',
          'read-only',
          '--cd',
          paths.root,
          ...flag('--model', model),
          ...flag(
            '-c',
            effort === undefined
              ? undefined
              : `model_reasoning_effort="${effort}"`,
          ),
          '-o',
          paths.out,
          '-',
        ],
        output: 'file',
        workspace: 'repo',
        env: {},
      };
    case 'claude':
      return {
        argv: [
          'claude',
          '-p',
          '--permission-mode',
          'dontAsk',
          '--tools',
          CLAUDE_TOOLS,
          '--allowedTools',
          CLAUDE_TOOLS,
          '--strict-mcp-config',
          '--no-session-persistence',
          '--output-format',
          'text',
          ...flag('--model', model),
          ...flag('--effort', effort),
        ],
        output: 'stdout',
        workspace: 'repo',
        env: {},
      };
    case 'opencode':
      // OpenCode has no enforced read-only mode for `run`: the plan agent and
      // the permission override deny writes, and the copy contains the blast
      // radius if either is ignored. Effort has no portable flag here.
      return {
        argv: ['opencode', 'run', '--agent', 'plan', ...flag('--model', model)],
        output: 'stdout',
        workspace: 'copy',
        env: { OPENCODE_PERMISSION },
      };
  }
}

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Terminal colour codes stripped, so a coloured verdict line still parses. */
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

const shellWord = (word: string): string =>
  /^[A-Za-z0-9._/:=@-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;

/** The `bun plan:review` invocation for a plan source and runner. */
export const retryCommand = (source: PlanSource, runner: string): string =>
  [
    'bun plan:review',
    source.kind === 'page'
      ? source.id
      : `--plan-file ${shellWord(source.path)}`,
    `--runner ${runner}`,
  ].join(' ');

const STDERR_TAIL = 20;
const LINE_LIMIT = 300;

/**
 * The failure report: runner, model, reason, the stderr tail and the exact
 * commands that retry with each other runner. A CLI that echoes its prompt
 * (Codex does) would leak the plan into the tail, so prompt lines are dropped.
 */
export function reviewFailure(input: {
  readonly reviewer: PlanReviewConfig;
  readonly command: readonly string[];
  readonly reason: string;
  readonly stderr: string;
  readonly prompt: string;
  readonly source: PlanSource;
}): string {
  const echoed = new Set(input.prompt.split('\n').map((line) => line.trim()));
  const tail = input.stderr
    .split('\n')
    .map((line) => stripAnsi(line).trimEnd())
    .filter((line) => line !== '' && !echoed.has(line.trim()))
    .slice(-STDERR_TAIL)
    .map((line) =>
      line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}…` : line,
    );
  const others = PLAN_REVIEW_RUNNERS.filter(
    (runner) => runner !== input.reviewer.runner,
  );
  return [
    `plan review failed: runner ${input.reviewer.runner}, model ${input.reviewer.model ?? "(the CLI's configured default)"}: ${input.reason}`,
    `command: ${input.command.map(shellWord).join(' ')}`,
    ...(tail.length === 0
      ? ['stderr: (empty)']
      : [`stderr (last ${tail.length} lines):`, ...tail.map((l) => `  ${l}`)]),
    'try another runner (or --model <model>):',
    ...others.map((runner) => `  ${retryCommand(input.source, runner)}`),
  ].join('\n');
}
