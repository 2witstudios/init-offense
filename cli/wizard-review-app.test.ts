import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { wizard } from './wizard';
import type { Accounts } from './wizard-accounts';
import { REVIEW_GATE_QUESTION, setUpReviewGate } from './wizard-review-app';
import { runLocally } from './wizard-run';
import { fakeDeps } from './wizard.test-support';

setupRitewayBun();

const scratch = mkdtempSync(join(tmpdir(), 'init-offense-review-gate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const accounts: Accounts = {
  display: 'Widget',
  slug: 'widget',
  target: '/work/widget',
  github: true,
  visibility: 'public',
  plan: 'free',
  drive: false,
  run: false,
  owner: 'octo',
};

const dryRun = async (extra: readonly string[], ownerType = 'User') => {
  const fake = fakeDeps({
    probes: {
      'gh api user --jq .login': { code: 0, stdout: 'octo\n' },
      'gh api users/octo --jq .type': { code: 0, stdout: `${ownerType}\n` },
    },
  });
  const code = await wizard(
    [
      '--dry-run',
      '--yes',
      '--public',
      '--no-drive',
      '--no-run',
      '--name',
      'widget',
      '--dir',
      join(scratch, 'widget'),
      ...extra,
    ],
    fake.deps,
  );
  return { code, fake, text: fake.logs.join('\n') };
};

describe('wizard review gate', () => {
  test('dry run shows every step', async () => {
    const { code, fake, text } = await dryRun([]);
    assert({
      given: '--dry-run --yes with a GitHub repository',
      should:
        'plan the gate, show bun github:review-app and its ten steps, run nothing and list the gate in the summary',
      actual: [
        code,
        fake.ran,
        text.includes('Set up the review gate, a GitHub App'),
        text.includes('[dry run] $ bun github:review-app'),
        fake.logs.filter((line) => line.startsWith('  [dry run]   ')).length,
        text.includes('https://github.com/settings/apps/new?state=<random>'),
        text.includes('  • Review gate: the review-record GitHub App'),
        text.includes('Reviews: turn on the review gate'),
      ],
      expected: [0, [], true, true, 10, true, true, false],
    });
  });

  test('an organization owner', async () => {
    const { text } = await dryRun([], 'Organization');
    assert({
      given: 'the owner is an organization',
      should: "show the organization's App settings as the manifest target",
      actual: text.includes(
        'https://github.com/organizations/octo/settings/apps/new?state=<random>',
      ),
      expected: true,
    });
  });

  test('--no-review-app', async () => {
    const { text } = await dryRun(['--no-review-app']);
    assert({
      given: '--no-review-app',
      should:
        'neither plan nor run the gate, and keep it as an optional next step',
      actual: [
        text.includes('github:review-app   (in'),
        text.includes('Set up the review gate'),
        text.includes(
          'Reviews: turn on the review gate with `bun github:review-app`',
        ),
      ],
      expected: [false, false, true],
    });
  });
});

describe('setUpReviewGate', () => {
  const flags = { yes: false, dryRun: false };

  test('asks, defaulting to yes', async () => {
    const asked: [string, boolean][] = [];
    const fake = fakeDeps({
      prompt: {
        confirm: async (question, fallback) => {
          asked.push([question.trim(), fallback]);
          return true;
        },
      },
    });
    const done = await setUpReviewGate(fake.deps, flags, accounts, true);
    assert({
      given: 'a pushed repository and a yes',
      should:
        'ask the plain question once (default yes) and run bun github:review-app in the project',
      actual: [asked, fake.ran, done],
      expected: [
        [[REVIEW_GATE_QUESTION, true]],
        ['bun github:review-app'],
        true,
      ],
    });
  });

  test('declined, failed, not pushed', async () => {
    const declined = fakeDeps({ prompt: { confirm: async () => false } });
    const failed = fakeDeps({
      prompt: { confirm: async () => true },
      run: () => 1,
    });
    const unpushed = fakeDeps();
    assert({
      given: 'a no, a failing setup, and a repository that was not pushed',
      should:
        'skip with the retry command, report failure with it, and not ask',
      actual: [
        await setUpReviewGate(declined.deps, flags, accounts, true),
        declined.ran,
        declined.logs.at(-1),
        await setUpReviewGate(failed.deps, flags, accounts, true),
        failed.logs
          .at(-1)
          ?.includes(
            'Retry any time: cd /work/widget && bun github:review-app',
          ),
        await setUpReviewGate(unpushed.deps, flags, accounts, false),
        unpushed.ran,
      ],
      expected: [
        false,
        [],
        'Skipped. Set it up later with: cd /work/widget && bun github:review-app',
        false,
        true,
        false,
        [],
      ],
    });
  });

  test('the summary', async () => {
    const fake = fakeDeps();
    await runLocally(fake.deps, flags, accounts, {
      drive: false,
      pushed: true,
      reviewGate: true,
    });
    const text = fake.logs.join('\n');
    assert({
      given: 'a run that set up the gate',
      should: 'list it as created and drop it from the next steps',
      actual: [
        text.includes('  • Review gate'),
        text.includes('Reviews: turn on'),
      ],
      expected: [true, false],
    });
  });
});
