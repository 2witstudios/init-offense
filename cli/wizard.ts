#!/usr/bin/env bun
/**
 * The guided way to start a project from this template:
 *
 *   bun cli/wizard.ts [dir] [--name <slug>] [--display <name>] [--dir <path>]
 *     [--owner <owner>] [--no-github] [--no-drive] [--no-run] [--yes] [--dry-run]
 *
 * `npx create-init-offense` (create/) fetches the template and runs this.
 * Steps: welcome → questions → tools → accounts → create → run locally.
 * See cli/README.md.
 */
import { TEMPLATE_ROOT } from './generate';
import { connectAccounts } from './wizard-accounts';
import { createEverything } from './wizard-create';
import { WizardStop, type WizardDeps } from './wizard-deps';
import { checkPrerequisites } from './wizard-prereqs';
import {
  askProject,
  parseWizardFlags,
  welcome,
  WIZARD_USAGE,
} from './wizard-questions';
import { runLocally } from './wizard-run';

/** Runs the wizard. Returns a process exit code. */
export async function wizard(
  argv: readonly string[],
  deps: WizardDeps,
): Promise<number> {
  const parsed = parseWizardFlags(argv);
  if ('help' in parsed) {
    deps.log(WIZARD_USAGE);
    return 0;
  }
  if ('error' in parsed) {
    deps.log(`Error: ${parsed.error}\n\n${WIZARD_USAGE}`);
    return 2;
  }
  const { flags } = parsed;
  try {
    welcome(deps, flags);
    const answers = await checkPrerequisites(
      deps,
      flags,
      await askProject(deps, flags),
    );
    const accounts = await connectAccounts(deps, flags, answers);
    const created = await createEverything(deps, flags, accounts);
    await runLocally(deps, flags, accounts, created);
    if (flags.dryRun)
      deps.log(
        '\nDry run finished: nothing was installed, created or changed.',
      );
    return 0;
  } catch (error) {
    if (error instanceof WizardStop) {
      deps.log(error.message);
      return error.code;
    }
    deps.log(
      `\nSomething went wrong: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  const { realDeps } = await import('./wizard-io');
  process.exit(await wizard(process.argv.slice(2), realDeps(TEMPLATE_ROOT)));
}
