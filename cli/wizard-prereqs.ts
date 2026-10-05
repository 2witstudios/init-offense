/**
 * Step 2 of the wizard: check the tools this run needs, offer to install
 * each missing one (showing the exact commands first), and re-check.
 */
import { act, WizardStop, type WizardDeps } from './wizard-deps';
import {
  dockerStartCommands,
  dockerState,
  installPlan,
  neededTools,
  shown,
  type DockerState,
  type Host,
  type Need,
  type Tool,
} from './wizard-plan';
import type { Answers, Flags } from './wizard-questions';

const DOCKER_WAIT_MS = 120_000;
const DOCKER_POLL_MS = 3_000;

const ok = (deps: WizardDeps, command: readonly string[]) =>
  deps.runner.probe(command).code === 0;

function detectHost(deps: WizardDeps): Host {
  const linux = deps.platform === 'linux';
  const packageManager = (() => {
    if (linux && ok(deps, ['apt-get', '--version'])) return 'apt' as const;
    if (linux && ok(deps, ['dnf', '--version'])) return 'dnf' as const;
    return null;
  })();
  return {
    platform: deps.platform,
    hasBrew: deps.platform === 'darwin' && ok(deps, ['brew', '--version']),
    packageManager,
  };
}

const VERSION_PROBE: Readonly<Record<Tool, readonly string[]>> = {
  git: ['git', '--version'],
  docker: ['docker', '--version'],
  gh: ['gh', '--version'],
  pagespace: ['pagespace', '--version'],
};

const installed = (deps: WizardDeps, tool: Tool) =>
  ok(deps, VERSION_PROBE[tool]);

const dockerNow = (deps: WizardDeps): DockerState =>
  dockerState(installed(deps, 'docker'), ok(deps, ['docker', 'info']));

async function install(
  deps: WizardDeps,
  flags: Flags,
  need: Need,
  host: Host,
): Promise<void> {
  const plan = installPlan(need.tool, host);
  deps.log(`\n${need.label} is not installed. It ${need.why}.`);
  if (plan.kind === 'manual') {
    plan.lines.forEach((line) => deps.log(`  ${line}`));
    if (flags.dryRun) return;
    await deps.prompt.pause(`Press Enter once ${need.label} is installed…`);
    return;
  }
  deps.log(`To install it, the wizard would run:`);
  plan.commands.forEach((command) => deps.log(`  ${shown(command)}`));
  if (plan.note) deps.log(`  (${plan.note})`);
  if (
    !flags.dryRun &&
    !(await deps.prompt.confirm(`Install ${need.label} now?`, true))
  )
    throw new WizardStop(
      `${need.label} is needed. Install it with the commands above, then run this again.`,
    );
  for (const command of plan.commands)
    if (act(deps, flags.dryRun, command) !== 0)
      throw new WizardStop(
        `Installing ${need.label} failed. Install it yourself, then run this again.`,
      );
}

async function waitForDocker(deps: WizardDeps, flags: Flags): Promise<boolean> {
  deps.log(
    '\nDocker is installed but not running. Start OrbStack or Docker Desktop.',
  );
  if (flags.dryRun) return true;
  for (const command of dockerStartCommands(deps.platform))
    if (deps.runner.probe(command).code === 0) {
      deps.log(`  started it with: ${shown(command)}`);
      break;
    }
  for (;;) {
    deps.log('Waiting for Docker to start (this can take a minute)…');
    for (let waited = 0; waited < DOCKER_WAIT_MS; waited += DOCKER_POLL_MS) {
      if (ok(deps, ['docker', 'info'])) return true;
      await deps.sleep(DOCKER_POLL_MS);
    }
    if (
      !(await deps.prompt.confirm(
        'Docker is still not running. Keep waiting?',
        true,
      ))
    )
      return false;
  }
}

function checklistLine(deps: WizardDeps, need: Need): string {
  const present = installed(deps, need.tool);
  if (present && need.tool === 'docker' && dockerNow(deps) === 'stopped')
    return `  ! ${need.label}: installed but not running`;
  return `  ${present ? '✓' : '✗'} ${need.label}: ${need.why}`;
}

function logBun(deps: WizardDeps): void {
  deps.log(`  ✓ Bun ${deps.bunVersion}`);
  if (deps.pinnedBunVersion && deps.pinnedBunVersion !== deps.bunVersion)
    deps.log(
      `    (the template is tested with Bun ${deps.pinnedBunVersion}; if installing fails, run: bun upgrade)`,
    );
}

/**
 * Checks every needed tool, installs what is missing with consent, and
 * returns the answers with `run` cleared when Docker never came up.
 */
export async function checkPrerequisites(
  deps: WizardDeps,
  flags: Flags,
  answers: Answers,
): Promise<Answers> {
  deps.log('\n— Step 2 of 5: tools —');
  logBun(deps);
  const needs = neededTools(answers);
  needs.forEach((need) => deps.log(checklistLine(deps, need)));
  const host = detectHost(deps);
  for (const need of needs) {
    if (installed(deps, need.tool)) continue;
    await install(deps, flags, need, host);
    if (!flags.dryRun && !installed(deps, need.tool))
      throw new WizardStop(
        `${need.label} still is not available. Open a new terminal and run this again.`,
      );
  }
  return ensureDocker(deps, flags, answers);
}

async function ensureDocker(
  deps: WizardDeps,
  flags: Flags,
  answers: Answers,
): Promise<Answers> {
  if (!answers.run || flags.dryRun || dockerNow(deps) === 'running')
    return answers;
  if (await waitForDocker(deps, flags)) return answers;
  deps.log(
    'Continuing without starting the app; run `bun slot:up && bun dev` in your project once Docker runs.',
  );
  return { ...answers, run: false };
}
