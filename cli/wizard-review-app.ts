/**
 * Step 4, after the push: offer the review gate. It runs the new project's
 * own `bun github:review-app` (scripts/github-review-app.ts), which creates
 * the review-record GitHub App from a manifest (browser click 1), stores its
 * id and key, waits for the install (click 2) and requires `review-record`
 * in the ruleset. The dry run shows the same steps from the same plan.
 */
import {
  appName,
  manifestFormUrl,
  ownerType,
  reviewAppSteps,
} from '../scripts/github-review-app-plan';
import type { Accounts } from './wizard-accounts';
import { act, type WizardDeps } from './wizard-deps';
import type { Flags } from './wizard-questions';

export const REVIEW_GATE_QUESTION =
  'Set up the review gate (a small GitHub App that only lets reviewed PRs merge)? It needs two clicks in your browser.';

const COMMAND = ['bun', 'github:review-app'];

/** Whether this run offers the review gate at all. */
export const offersReviewGate = (flags: Flags, accounts: Accounts): boolean =>
  accounts.github && flags.reviewApp !== false;

function showDryRun(deps: WizardDeps, accounts: Accounts): void {
  const owner = deps.runner.probe([
    'gh',
    'api',
    `users/${accounts.owner}`,
    '--jq',
    '.type',
  ]);
  const type = ownerType(owner.code, owner.stdout) ?? 'User';
  reviewAppSteps({
    repository: `${accounts.owner}/${accounts.slug}`,
    name: appName(accounts.slug),
    formUrl: manifestFormUrl(accounts.owner, type, '<random>'),
  }).forEach((step, index) => deps.log(`  [dry run]   ${index + 1}. ${step}`));
}

/** Returns true when the gate is set up (or would be, in a dry run). */
export async function setUpReviewGate(
  deps: WizardDeps,
  flags: Flags,
  accounts: Accounts,
  pushed: boolean,
): Promise<boolean> {
  if (!offersReviewGate(flags, accounts) || !pushed) return false;
  const yes =
    flags.yes ||
    flags.dryRun ||
    (await deps.prompt.confirm(`\n${REVIEW_GATE_QUESTION}`, true));
  if (!yes) {
    deps.log(
      `Skipped. Set it up later with: cd ${accounts.target} && bun github:review-app`,
    );
    return false;
  }
  deps.log('\nThe review gate: a GitHub App only reviewed PRs can merge past.');
  const code = act(deps, flags.dryRun, COMMAND, { cwd: accounts.target });
  if (flags.dryRun) showDryRun(deps, accounts);
  if (code === 0) return true;
  deps.log(
    `The review gate was not finished; your app still works. Retry any time: cd ${accounts.target} && bun github:review-app`,
  );
  return false;
}
