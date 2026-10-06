import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { wizard } from './wizard';
import type { Choice } from './wizard-deps';
import {
  defaultVisibility,
  githubPlan,
  privateOnFreeNote,
  visibilityExplanation,
} from './wizard-plan';
import { parseWizardFlags } from './wizard-questions';
import { fakeDeps, type FakeOptions } from './wizard.test-support';

setupRitewayBun();

const PLAN = 'gh api user --jq .plan.name';
const LOGIN = 'gh api user --jq .login';
const FIX =
  'To make it public: gh repo edit octo/viz --visibility public --accept-visibility-change-consequences';

const probes = (plan: string | null): NonNullable<FakeOptions['probes']> => ({
  [LOGIN]: { code: 0, stdout: 'octo\n' },
  [PLAN]: plan === null ? { code: 1, stdout: '' } : { code: 0, stdout: plan },
});

const dryRun = async (plan: string | null, extra: string[] = []) => {
  const fake = fakeDeps({ probes: probes(plan) });
  const code = await wizard(
    [
      '--dry-run',
      '--yes',
      '--name',
      'viz',
      '--dir',
      '/work/viz',
      '--no-drive',
      '--no-run',
      ...extra,
    ],
    fake.deps,
  );
  const text = fake.logs.join('\n');
  return { code, text, fake };
};

describe('visibility planning', () => {
  test('defaultVisibility and githubPlan', () => {
    assert({
      given: 'the free plan, a paid plan, an unknown plan and a failed probe',
      should:
        'suggest public only on free, and read the plan only from a successful probe',
      actual: [
        defaultVisibility('free'),
        defaultVisibility('pro'),
        defaultVisibility(null),
        githubPlan(0, 'free\n'),
        githubPlan(0, ''),
        githubPlan(1, 'free'),
      ],
      expected: ['public', 'private', 'private', 'free', null, null],
    });
  });

  test('the explanation names both trade-offs and the suggestion', () => {
    const text = visibilityExplanation('free').join('\n');
    assert({
      given: 'a free plan',
      should: 'explain public and private and suggest public',
      actual: [
        text.includes('anyone can read your code'),
        text.includes("can't be enforced and CI minutes are limited"),
        text.includes('Your GitHub plan: free, so public is suggested.'),
      ],
      expected: [true, true, true],
    });
  });

  test('privateOnFreeNote', () => {
    assert({
      given:
        'private on free, public on free, private on pro and private unknown',
      should:
        'warn with the fix for private on free or an unknown plan, never on public or pro',
      actual: [
        privateOnFreeNote('octo/viz', 'private', 'free').includes(FIX),
        privateOnFreeNote('octo/viz', 'public', 'free'),
        privateOnFreeNote('octo/viz', 'private', 'pro'),
        privateOnFreeNote('octo/viz', 'private', null).includes(FIX),
      ],
      expected: [true, [], [], true],
    });
  });
});

describe('visibility flags', () => {
  test('conflicts', () => {
    const error = (argv: string[]) => {
      const parsed = parseWizardFlags(argv);
      return 'error' in parsed ? parsed.error : null;
    };
    assert({
      given: '--public with --private, and --public with --no-github',
      should: 'refuse each in plain words',
      actual: [
        error(['--public', '--private']),
        error(['--public', '--no-github']),
        error(['--private']),
      ],
      expected: [
        '--public and --private cannot be used together',
        '--public needs a GitHub repository; drop --no-github',
        null,
      ],
    });
  });
});

describe('wizard visibility', () => {
  test('--yes on a free plan stays private', async () => {
    const { code, text } = await dryRun('free');
    assert({
      given: 'a free GitHub plan, --yes and no visibility flag',
      should:
        'never make code public implicitly: create a private repository and print the fix',
      actual: [
        code,
        text.includes('GitHub repository: yes, private'),
        text.includes('gh repo create octo/viz --private'),
        text.includes(FIX),
      ],
      expected: [0, true, true, true],
    });
  });

  test('--yes keeps the app name its default', async () => {
    const { text } = await dryRun('free');
    assert({
      given: '--yes with --name viz and no --display',
      should: 'name the app from the slug, never after the visibility',
      actual: text.includes('App: "Viz" (viz)'),
      expected: true,
    });
  });

  test('--public on a free plan creates a public repository', async () => {
    const { code, text } = await dryRun('free', ['--public']);
    assert({
      given: 'a free GitHub plan and --public',
      should: 'create a public repository and print no warning',
      actual: [
        code,
        text.includes('gh repo create octo/viz --public'),
        text.includes(FIX),
      ],
      expected: [0, true, false],
    });
  });

  test('--private on a free plan warns in the summary', async () => {
    const { code, text } = await dryRun('free', ['--private']);
    assert({
      given: '--private on a free GitHub plan',
      should: 'create a private repository and print the limitation and fix',
      actual: [
        code,
        text.includes('gh repo create octo/viz --private'),
        text.includes('is private on a free GitHub plan'),
        text.includes(FIX),
      ],
      expected: [0, true, true, true],
    });
  });

  test('a paid or unknown plan defaults to private; only unknown gets a conditional note', async () => {
    const pro = await dryRun('pro');
    const unknown = await dryRun(null);
    assert({
      given: 'a pro plan, and a plan gh cannot read',
      should:
        'default to private, warn nothing on pro and warn conditionally when unknown',
      actual: [pro.text, unknown.text].map((text) => [
        text.includes('gh repo create octo/viz --private'),
        text.includes(FIX),
        text.includes('if your GitHub plan is free'),
      ]),
      expected: [
        [true, false, false],
        [true, true, true],
      ],
    });
  });

  test('asks the question, defaulting to the suggestion, and honours the answer', async () => {
    const asked: string[] = [];
    const fake = fakeDeps({
      probes: probes('free'),
      prompt: {
        text: async (_question, fallback) => fallback,
        confirm: async () => true,
        select: async <T extends string>(
          question: string,
          choices: readonly Choice<T>[],
          fallback: T,
        ) => {
          asked.push(
            `${question} [${choices.map((c) => c.value)}] ${fallback}`,
          );
          return (asked.length === 1 ? 'private' : fallback) as T;
        },
      },
    });
    await wizard(
      [
        '--dry-run',
        '--name',
        'viz',
        '--dir',
        '/work/viz',
        '--no-drive',
        '--no-run',
      ],
      fake.deps,
    );
    const text = fake.logs.join('\n');
    assert({
      given: 'an interactive run on a free plan answering private',
      should:
        'ask with public suggested, then create a private repository and warn',
      actual: [
        asked[0],
        text.includes('gh repo create octo/viz --private'),
        text.includes(FIX),
      ],
      expected: [
        'Should the repository be public or private? [public,private] public',
        true,
        true,
      ],
    });
  });
});
