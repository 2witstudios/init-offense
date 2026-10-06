import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  envLayer,
  OPENCODE_PERMISSION,
  parsePlanReviewArgs,
  resolveReviewer,
  retryCommand,
  reviewerCommand,
  reviewFailure,
  stripAnsi,
} from './plan-reviewer';
import { thrown } from './project-config.test-support';

setupRitewayBun();

const PAGE = 'abcdefghij0123456789abcd';

describe('parsePlanReviewArgs', () => {
  test('reads a page id or a plan file with runner, model and effort', () => {
    assert({
      given: 'a page id, a plan file, and both flag spellings',
      should: 'return the plan source and the flag layer',
      actual: [
        parsePlanReviewArgs([PAGE]),
        parsePlanReviewArgs([
          '--plan-file',
          'plan.md',
          '--runner',
          'claude',
          '--model=opus',
          '--effort',
          'high',
        ]),
      ],
      expected: [
        { source: { kind: 'page', id: PAGE } },
        {
          source: { kind: 'file', path: 'plan.md' },
          runner: 'claude',
          model: 'opus',
          effort: 'high',
        },
      ],
    });
  });

  test('refuses a missing plan, two plans, a bare flag and unknown options', () => {
    assert({
      given: 'malformed command lines',
      should: 'name the usage problem',
      actual: [
        parsePlanReviewArgs([]),
        parsePlanReviewArgs(['Not-An-Id']),
        parsePlanReviewArgs([PAGE, '--plan-file', 'plan.md']),
        parsePlanReviewArgs([PAGE, '--runner']),
        parsePlanReviewArgs([PAGE, '--sandbox', 'off']),
      ],
      expected: [
        { error: 'expected a plan page id or --plan-file <path>' },
        { error: 'expected a plan page id or --plan-file <path>' },
        { error: 'pass a plan page id or --plan-file, not both' },
        { error: '--runner needs a value' },
        { error: 'unknown option --sandbox' },
      ],
    });
  });
});

describe('resolveReviewer', () => {
  const config = { runner: 'codex', model: 'gpt-5.5', effort: 'low' } as const;
  const resolve = (flags = {}, env = {}) =>
    resolveReviewer({ flags, env, config });

  test('prefers flag over env over config', () => {
    assert({
      given: 'a runner in every layer',
      should: 'take the flag, then the env, then the config',
      actual: [
        resolve({ runner: 'claude' }, { runner: 'opencode' }).runner,
        resolve({}, { runner: 'opencode' }).runner,
        resolve().runner,
      ],
      expected: ['claude', 'opencode', 'codex'],
    });
  });

  test("keeps the config's model and effort for the configured runner only", () => {
    assert({
      given: 'a codex config with a model, overridden to claude or not',
      should: 'drop the codex model for claude and keep it for codex',
      actual: [
        resolve(),
        resolve({ runner: 'claude' }),
        resolve({ runner: 'claude', model: 'opus' }),
        resolve({ model: 'gpt-5.4' }, { model: 'o3', effort: 'high' }),
        resolve({}, { runner: 'claude', model: 'sonnet' }),
      ],
      expected: [
        { runner: 'codex', model: 'gpt-5.5', effort: 'low' },
        { runner: 'claude' },
        { runner: 'claude', model: 'opus' },
        { runner: 'codex', model: 'gpt-5.4', effort: 'high' },
        { runner: 'claude', model: 'sonnet' },
      ],
    });
  });

  test('reads the environment, treating empty variables as unset', () => {
    assert({
      given: 'PLAN_REVIEW_* variables, one of them empty',
      should: 'return only the set ones',
      actual: envLayer({
        PLAN_REVIEW_RUNNER: 'claude',
        PLAN_REVIEW_MODEL: '',
        PLAN_REVIEW_EFFORT: 'max',
      }),
      expected: { runner: 'claude', model: undefined, effort: 'max' },
    });
  });

  test('refuses an unknown runner or an argument-shaped model, naming the source', () => {
    assert({
      given: 'a bad flag runner, a bad env runner and a dash-led model',
      should: 'throw with the flag or variable name',
      actual: [
        thrown(() => resolve({ runner: 'gemini' })),
        thrown(() => resolve({}, { runner: 'gemini' })),
        thrown(() => resolve({ model: '--dangerously-bypass' })),
      ],
      expected: [
        '--runner must be one of codex, claude, opencode',
        'PLAN_REVIEW_RUNNER must be one of codex, claude, opencode',
        '--model must match /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/',
      ],
    });
  });
});

describe('reviewerCommand', () => {
  const paths = { root: '/repo', out: '/tmp/review.md' };

  test('runs codex in its read-only sandbox, model and effort before the prompt', () => {
    assert({
      given: 'codex with and without a model and effort',
      should: 'emit the exact argv, writing the final message to the out file',
      actual: [
        reviewerCommand({ runner: 'codex' }, paths),
        reviewerCommand(
          { runner: 'codex', model: 'gpt-5.5', effort: 'high' },
          paths,
        ).argv,
      ],
      expected: [
        {
          argv: [
            'codex',
            'exec',
            '--sandbox',
            'read-only',
            '--cd',
            '/repo',
            '-o',
            '/tmp/review.md',
            '-',
          ],
          output: 'file',
          workspace: 'repo',
          env: {},
        },
        [
          'codex',
          'exec',
          '--sandbox',
          'read-only',
          '--cd',
          '/repo',
          '--model',
          'gpt-5.5',
          '-c',
          'model_reasoning_effort="high"',
          '-o',
          '/tmp/review.md',
          '-',
        ],
      ],
    });
  });

  test('runs Claude Code headless with read-only tools and no prompts', () => {
    const base = [
      'claude',
      '-p',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read,Grep,Glob',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--output-format',
      'text',
    ];
    assert({
      given: 'claude with and without a model and effort',
      should: 'emit the exact argv and capture stdout',
      actual: [
        reviewerCommand({ runner: 'claude' }, paths),
        reviewerCommand(
          { runner: 'claude', model: 'opus', effort: 'high' },
          paths,
        ).argv,
      ],
      expected: [
        { argv: base, output: 'stdout', workspace: 'repo', env: {} },
        [...base, '--model', 'opus', '--effort', 'high'],
      ],
    });
  });

  test('runs opencode with the plan agent, denied writes, in a throwaway copy', () => {
    assert({
      given: 'opencode with and without a provider/model',
      should: 'emit the exact argv, deny every writing tool and use a copy',
      actual: [
        reviewerCommand({ runner: 'opencode' }, paths),
        reviewerCommand(
          { runner: 'opencode', model: 'anthropic/claude-opus', effort: 'x' },
          paths,
        ).argv,
        JSON.parse(OPENCODE_PERMISSION),
      ],
      expected: [
        {
          argv: ['opencode', 'run', '--agent', 'plan'],
          output: 'stdout',
          workspace: 'copy',
          env: { OPENCODE_PERMISSION },
        },
        [
          'opencode',
          'run',
          '--agent',
          'plan',
          '--model',
          'anthropic/claude-opus',
        ],
        {
          edit: 'deny',
          bash: 'deny',
          webfetch: 'deny',
          external_directory: 'deny',
        },
      ],
    });
  });

  test('never grants a writing tool or a sandbox bypass to any runner', () => {
    const argv = (['codex', 'claude', 'opencode'] as const).flatMap(
      (runner) => reviewerCommand({ runner }, paths).argv,
    );
    assert({
      given: 'every runner',
      should: 'name no edit, write or bypass option',
      actual: argv.filter((arg) =>
        /Edit|Write|bypass|danger|workspace-write|acceptEdits|--auto\b/i.test(
          arg,
        ),
      ),
      expected: [],
    });
  });
});

describe('stripAnsi', () => {
  test('removes colour codes around a verdict', () => {
    assert({
      given: 'a coloured verdict line',
      should: 'return the bare line',
      actual: stripAnsi('\u001b[0m\u001b[1mPLAN REVIEW: APPROVE\u001b[0m'),
      expected: 'PLAN REVIEW: APPROVE',
    });
  });
});

describe('reviewFailure', () => {
  const failure = reviewFailure({
    reviewer: { runner: 'codex' },
    command: ['codex', 'exec', '--sandbox', 'read-only', '-'],
    reason: 'exited with code 1',
    stderr: `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\nuser\n  Secret plan step.\nERROR: model not supported\n\n`,
    prompt: 'You are an external reviewer.\n## Plan\nSecret plan step.',
    source: { kind: 'page', id: PAGE },
  });

  test('names the runner, model, reason, stderr tail and the retry commands', () => {
    assert({
      given: 'a codex run that exited non-zero without a model',
      should: 'report every fact needed to retry with another runner',
      actual: [
        failure.split('\n')[0],
        failure.includes('command: codex exec --sandbox read-only -'),
        failure.includes('stderr (last 20 lines):'),
        failure.includes('  ERROR: model not supported'),
        failure.includes('line 11\n'),
        failure.includes('Secret plan step'),
        failure.includes(`  bun plan:review ${PAGE} --runner claude`),
        failure.includes(`  bun plan:review ${PAGE} --runner opencode`),
        failure.includes('--runner codex'),
      ],
      expected: [
        "plan review failed: runner codex, model (the CLI's configured default): exited with code 1",
        true,
        true,
        true,
        false,
        false,
        true,
        true,
        false,
      ],
    });
  });

  test('quotes a plan file path in the retry command', () => {
    assert({
      given: 'a plan file path with a space',
      should: 'shell-quote it',
      actual: retryCommand({ kind: 'file', path: '/tmp/my plan.md' }, 'claude'),
      expected: "bun plan:review --plan-file '/tmp/my plan.md' --runner claude",
    });
  });
});
