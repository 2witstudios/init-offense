#!/usr/bin/env bun
/**
 * `bun plan:review <planPageId> | --plan-file <path> [--runner r]
 * [--model m] [--effort e]`: the automated external plan review of the epic
 * pipeline. A read-only reviewer CLI (Codex, Claude Code or OpenCode; see
 * plan-reviewer.ts and project.config.json `planReview`) reads the plan with
 * AGENTS.md and the accepted ADRs in hand, before any tasking, so a plan
 * that contradicts a decision (a backfill under ADR 0023, UUIDs under ADR
 * 0018) is caught before builders fan out. Prints the review; the
 * epic-pipeline skill publishes it and stops for owner approval.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  envLayer,
  parsePlanReviewArgs,
  PLAN_REVIEW_USAGE,
  resolveReviewer,
  reviewerCommand,
  reviewFailure,
  stripAnsi,
  type PlanSource,
  type ReviewerCommand,
} from './plan-reviewer';
import { loadProjectConfig, type PlanReviewConfig } from './project-config';

type Adr = {
  readonly number: string;
  readonly title: string;
  /** A later ADR replaced it: listed so a plan citing it is caught. */
  readonly superseded?: boolean;
};

type AdrFile = {
  readonly file: string;
  readonly firstLine: string;
  /** The record's "Status:" line, when it has one. */
  readonly status?: string;
};

/** A decision record's file name, heading line and status line. */
export function adrFile(dir: string, file: string): AdrFile {
  const lines = readFileSync(join(dir, file), 'utf8').split('\n');
  return {
    file,
    firstLine: lines[0] ?? '',
    status: lines.find((line) => /^Status:/i.test(line)),
  };
}

/**
 * Every decision record, numbered by its file name. The title comes from a
 * "# 0023: …" or "# ADR 0001: …" heading, or else from the file name, so
 * no record is left out of the review.
 */
export function adrIndex(files: readonly AdrFile[]): readonly Adr[] {
  return files
    .flatMap(({ file, firstLine, status }) => {
      const named = /^(\d{4})-(.+)\.md$/.exec(file);
      if (!named) return [];
      const heading = /^#\s*(?:ADR\s+)?\d{4}:\s*(.+)$/.exec(firstLine.trim());
      const title = heading?.[1] ?? named[2].replaceAll('-', ' ');
      const superseded = /^Status:\s*superseded/i.test(status ?? '');
      return [{ number: named[1], title, superseded }];
    })
    .sort((a, b) => a.number.localeCompare(b.number));
}

export function planReviewPrompt(input: {
  readonly agents: string;
  readonly adrs: readonly Adr[];
  readonly plan: string;
}): string {
  return [
    'You are an external reviewer of an implementation plan for this repository, before any of it is tasked. You do not edit anything.',
    'Review the plan against the repository contract (AGENTS.md) and the accepted decisions (docs/decisions). Read any ADR in full when the plan touches it.',
    'Report, each with severity (blocker, major, minor), the plan section and the AGENTS.md rule or ADR it concerns:',
    '- anything that contradicts AGENTS.md or an accepted ADR (for example a backfill, compat path or legacy mode under the greenfield baseline, or UUIDs where cuid2 is decided);',
    '- terms or approaches a later ADR superseded;',
    '- work that depends on a decision, contract or prerequisite that is not merged, and leaves that must be sequenced rather than run in parallel;',
    '- ADR or migration numbers the plan claims (they come from bun adr:next at the time, not the plan);',
    '- acceptance criteria that are ambiguous, untestable or cannot be proven by a test that fails when the behaviour is removed.',
    'End with exactly one line: "PLAN REVIEW: APPROVE" or "PLAN REVIEW: CHANGES REQUESTED".',
    '',
    '## AGENTS.md',
    input.agents,
    '',
    '## Decisions (superseded ones are marked and are not in force)',
    ...input.adrs.map(
      (adr) =>
        `ADR ${adr.number}: ${adr.title}${adr.superseded ? ' (superseded: not in force)' : ''}`,
    ),
    '',
    '## Plan',
    input.plan,
  ].join('\n');
}

/** The last line that is exactly a verdict; a verdict quoted in prose never counts. */
export function parseVerdict(
  output: string,
): 'APPROVE' | 'CHANGES REQUESTED' | undefined {
  const verdict = output
    .split('\n')
    .map(
      (line) =>
        /^PLAN REVIEW: (APPROVE|CHANGES REQUESTED)$/.exec(line.trim())?.[1],
    )
    .findLast((match) => match !== undefined);
  return verdict as 'APPROVE' | 'CHANGES REQUESTED' | undefined;
}

/** A throwaway copy of the tracked and unignored files (never `.env`). */
function workspaceCopy(root: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'plan-review-'));
  const listed = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  for (const file of listed.stdout.toString().split('\0')) {
    if (file === '' || !existsSync(join(root, file))) continue;
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    copyFileSync(join(root, file), join(copy, file));
  }
  return copy;
}

type RunResult = { readonly stderr: string } & (
  { readonly review: string } | { readonly reason: string }
);

/** Runs one reviewer with the prompt on stdin; never touches the checkout. */
function runReviewer(
  command: ReviewerCommand,
  prompt: string,
  root: string,
  out: string,
): RunResult {
  const [bin] = command.argv;
  if (Bun.which(bin) === null)
    return { reason: `${bin} is not installed (not on PATH)`, stderr: '' };
  const cwd = command.workspace === 'copy' ? workspaceCopy(root) : root;
  try {
    const run = Bun.spawnSync([...command.argv], {
      cwd,
      env: { ...process.env, ...command.env },
      stdin: Buffer.from(prompt),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = run.stderr.toString();
    if (run.exitCode !== 0)
      return { reason: `exited with code ${run.exitCode}`, stderr };
    const fromFile = existsSync(out) ? readFileSync(out, 'utf8') : '';
    const review = command.output === 'file' ? fromFile : run.stdout.toString();
    return { review: stripAnsi(review), stderr };
  } finally {
    rmSync(out, { force: true });
    if (cwd !== root) rmSync(cwd, { recursive: true, force: true });
  }
}

function readPlan(source: PlanSource): string {
  if (source.kind === 'file') return readFileSync(source.path, 'utf8');
  const plan = Bun.spawnSync(
    ['pagespace', 'pages', 'read', source.id, '--json'],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  if (plan.exitCode !== 0) process.exit(1);
  return (
    (JSON.parse(plan.stdout.toString()) as { content?: string }).content ?? ''
  );
}

function reviewerFromEnvironment(
  root: string,
  flags: Parameters<typeof resolveReviewer>[0]['flags'],
): PlanReviewConfig {
  try {
    return resolveReviewer({
      flags,
      env: envLayer(process.env),
      config: loadProjectConfig(root).planReview,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${PLAN_REVIEW_USAGE}\n`);
    return process.exit(2);
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const args = parsePlanReviewArgs(process.argv.slice(2));
  if ('error' in args) {
    process.stderr.write(`${args.error}\n${PLAN_REVIEW_USAGE}\n`);
    process.exit(2);
  }
  const reviewer = reviewerFromEnvironment(root, args);
  const decisions = join(root, 'docs/decisions');
  const prompt = planReviewPrompt({
    agents: readFileSync(join(root, 'AGENTS.md'), 'utf8'),
    adrs: adrIndex(
      readdirSync(decisions).map((file) => adrFile(decisions, file)),
    ),
    plan: readPlan(args.source),
  });
  const out = join(tmpdir(), `plan-review-${process.pid}.md`);
  const command = reviewerCommand(reviewer, { root, out });
  process.stderr.write(
    `plan review: running ${reviewer.runner} (model ${reviewer.model ?? 'default'})\n`,
  );
  const result = runReviewer(command, prompt, root, out);
  const review = 'review' in result ? result.review : '';
  process.stdout.write(
    review === '' || review.endsWith('\n') ? review : `${review}\n`,
  );
  const verdict = parseVerdict(review);
  if (!verdict)
    process.stderr.write(
      `${reviewFailure({
        reviewer,
        command: command.argv,
        reason:
          'reason' in result
            ? result.reason
            : 'produced no "PLAN REVIEW: APPROVE" or "PLAN REVIEW: CHANGES REQUESTED" line',
        stderr: result.stderr,
        prompt,
        source: args.source,
      })}\n`,
    );
  process.stderr.write(
    `plan review: ${verdict ?? 'NO VERDICT (treat as not reviewed)'}\n`,
  );
  process.exit(verdict ? 0 : 1);
}
